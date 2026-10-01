// ChatGPT/Codex 订阅登录（09 §4）：浏览器授权（PKCE + 本机回调）与设备码两种方式。
// 令牌以主密钥 AES-256-GCM 加密存入 credentials（kind=oauth），到期前自动刷新；刷新失败
// 在账号上记录错误并提示重新登录。登录成功后自动创建对应模型档案（可删除、可改名）。
// OAuth 端点与 client_id 取自 openai/codex 开源客户端（2026-10 核实）；接口非公开，可能变化。

import { createHash, randomBytes } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { DatabaseSync } from "node:sqlite";
import { newId, nowIso } from "@excelmanus/core";
import { redactSecrets } from "@excelmanus/models";
import type { Account, LoginAttempt } from "@excelmanus/protocol";
import { decryptSecret, encryptSecret } from "./crypto.ts";

export const CHATGPT_ISSUER = "https://auth.openai.com";
export const CHATGPT_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const CALLBACK_PORT = 1455;
const SCOPE = "openid profile email offline_access";
const REFRESH_WINDOW_MS = 5 * 60_000;
const ATTEMPT_TTL_MS = 15 * 60_000;

interface TokenSet {
  accessToken: string;
  refreshToken: string;
  idToken?: string;
  expiresAt: number;
  accountId?: string;
}

interface AccountMeta {
  label?: string;
  email?: string | null;
  plan?: string | null;
  accountId?: string;
  expiresAt?: string;
  error?: string | null;
}

interface Attempt {
  dto: LoginAttempt;
  verifier?: string;
  state?: string;
  deviceAuthId?: string;
  interval?: number;
  expiresAt: number;
}

const b64url = (buf: Buffer) => buf.toString("base64url");

/** 解析 JWT 负载（不验签：令牌直接来自 TLS 连接的令牌端点，只用于展示与账号 ID）。 */
export function jwtClaims(token: string | undefined): Record<string, unknown> {
  if (!token) return {};
  try {
    return JSON.parse(
      Buffer.from(token.split(".")[1] ?? "", "base64url").toString("utf8"),
    ) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function identity(tokens: { idToken?: string; accessToken: string }) {
  const claims = jwtClaims(tokens.idToken);
  const auth = (claims["https://api.openai.com/auth"] ?? {}) as Record<string, unknown>;
  const access = (jwtClaims(tokens.accessToken)["https://api.openai.com/auth"] ?? {}) as Record<
    string,
    unknown
  >;
  const str = (v: unknown) => (typeof v === "string" && v !== "" ? v : undefined);
  return {
    email: str(claims.email) ?? null,
    plan: str(auth.chatgpt_plan_type) ?? str(access.chatgpt_plan_type) ?? null,
    accountId: str(auth.chatgpt_account_id) ?? str(access.chatgpt_account_id),
  };
}

export interface AccountServiceOptions {
  db: DatabaseSync;
  masterKey: Buffer;
  fetchImpl?: typeof fetch;
  issuer?: string;
  /** 登录成功后创建档案（返回新档案 id）。 */
  onLoggedIn(account: Account): string[];
  log?(event: string, fields: Record<string, string | number | boolean>): void;
}

export class AccountService {
  private readonly o: AccountServiceOptions;
  private readonly attempts = new Map<string, Attempt>();
  private callback?: Server;
  private refreshing = new Map<string, Promise<string>>();

  constructor(opts: AccountServiceOptions) {
    this.o = opts;
  }

  private get fetch(): typeof fetch {
    return this.o.fetchImpl ?? fetch;
  }

  private get issuer(): string {
    return (this.o.issuer ?? CHATGPT_ISSUER).replace(/\/+$/, "");
  }

  // ---------- 账号存储 ----------

  private rows(): { id: string; provider: string; meta: string; created_at: string }[] {
    return this.o.db
      .prepare(
        "SELECT id, provider, meta, created_at FROM credentials WHERE kind = 'oauth' ORDER BY created_at",
      )
      .all() as { id: string; provider: string; meta: string; created_at: string }[];
  }

  private dto(row: { id: string; provider: string; meta: string; created_at: string }): Account {
    const meta = JSON.parse(row.meta) as AccountMeta;
    return {
      id: row.id,
      provider: row.provider,
      label: meta.label ?? meta.email ?? "ChatGPT 账号",
      email: meta.email ?? null,
      plan: meta.plan ?? null,
      expiresAt: meta.expiresAt ?? null,
      error: meta.error ? redactSecrets(meta.error) : null,
      createdAt: row.created_at,
    };
  }

  list(): Account[] {
    return this.rows().map((r) => this.dto(r));
  }

  get(id: string): Account | undefined {
    const row = this.rows().find((r) => r.id === id);
    return row ? this.dto(row) : undefined;
  }

  delete(id: string): boolean {
    if (!this.get(id)) return false;
    this.o.db.exec("BEGIN IMMEDIATE");
    try {
      this.o.db
        .prepare("UPDATE model_profiles SET credential_id = NULL WHERE credential_id = ?")
        .run(id);
      this.o.db.prepare("DELETE FROM credentials WHERE id = ?").run(id);
      this.o.db.exec("COMMIT");
    } catch (e) {
      this.o.db.exec("ROLLBACK");
      throw e;
    }
    return true;
  }

  private readTokens(id: string): TokenSet | undefined {
    const row = this.o.db
      .prepare("SELECT ciphertext, nonce FROM credentials WHERE id = ? AND kind = 'oauth'")
      .get(id) as { ciphertext: Uint8Array; nonce: Uint8Array } | undefined;
    if (!row) return undefined;
    return JSON.parse(
      decryptSecret(this.o.masterKey, Buffer.from(row.ciphertext), Buffer.from(row.nonce)),
    ) as TokenSet;
  }

  private writeTokens(id: string | undefined, tokens: TokenSet, extra: AccountMeta = {}): string {
    const ident = identity(tokens);
    const { ciphertext, nonce } = encryptSecret(this.o.masterKey, JSON.stringify(tokens));
    const now = nowIso();
    const meta: AccountMeta = {
      email: ident.email,
      plan: ident.plan,
      accountId: tokens.accountId ?? ident.accountId,
      expiresAt: new Date(tokens.expiresAt).toISOString(),
      error: null,
      ...extra,
    };
    if (id) {
      const prev = JSON.parse(
        (this.o.db.prepare("SELECT meta FROM credentials WHERE id = ?").get(id) as { meta: string })
          .meta,
      ) as AccountMeta;
      this.o.db
        .prepare(
          "UPDATE credentials SET ciphertext = ?, nonce = ?, meta = ?, updated_at = ? WHERE id = ?",
        )
        .run(ciphertext, nonce, JSON.stringify({ ...prev, ...meta }), now, id);
      return id;
    }
    // 同一账号重复登录：更新原凭据，档案保持关联
    const same = this.rows().find((r) => {
      const m = JSON.parse(r.meta) as AccountMeta;
      return m.accountId !== undefined && m.accountId === meta.accountId;
    });
    if (same) return this.writeTokens(same.id, tokens, extra);
    const newIdValue = newId("cred");
    this.o.db
      .prepare(
        "INSERT INTO credentials (id, kind, provider, ciphertext, nonce, meta, created_at, updated_at) VALUES (?, 'oauth', 'chatgpt', ?, ?, ?, ?, ?)",
      )
      .run(
        newIdValue,
        ciphertext,
        nonce,
        JSON.stringify({ label: meta.email ?? "ChatGPT 账号", ...meta }),
        now,
        now,
      );
    return newIdValue;
  }

  private setError(id: string, error: string | null): void {
    const row = this.o.db.prepare("SELECT meta FROM credentials WHERE id = ?").get(id) as
      | { meta: string }
      | undefined;
    if (!row) return;
    const meta = {
      ...(JSON.parse(row.meta) as AccountMeta),
      error: error ? redactSecrets(error) : null,
    };
    this.o.db
      .prepare("UPDATE credentials SET meta = ?, updated_at = ? WHERE id = ?")
      .run(JSON.stringify(meta), nowIso(), id);
  }

  /** 供模型网关使用：有效访问令牌（到期前 5 分钟内自动刷新，并发去重）。 */
  subscription(id: string): { accessToken(): Promise<string>; accountId?: string } | undefined {
    const tokens = this.readTokens(id);
    if (!tokens) return undefined;
    const meta = JSON.parse(
      (this.o.db.prepare("SELECT meta FROM credentials WHERE id = ?").get(id) as { meta: string })
        .meta,
    ) as AccountMeta;
    return {
      accountId: tokens.accountId ?? meta.accountId,
      accessToken: async () => {
        const cur = this.readTokens(id);
        if (!cur) throw new Error("订阅账号已删除，请重新登录");
        if (cur.expiresAt - Date.now() > REFRESH_WINDOW_MS) return cur.accessToken;
        return this.refresh(id);
      },
    };
  }

  async refresh(id: string): Promise<string> {
    const running = this.refreshing.get(id);
    if (running) return running;
    const p = (async () => {
      const cur = this.readTokens(id);
      if (!cur) throw new Error("订阅账号不存在");
      const res = await this.fetch(`${this.issuer}/oauth/token`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          client_id: CHATGPT_CLIENT_ID,
          grant_type: "refresh_token",
          refresh_token: cur.refreshToken,
          scope: SCOPE,
        }),
        signal: AbortSignal.timeout(30_000),
      });
      if (!res.ok) {
        const msg =
          res.status === 400 || res.status === 401
            ? "登录已失效（刷新令牌过期或被撤销），请在设置中重新登录"
            : `刷新令牌失败：HTTP ${res.status}`;
        this.setError(id, msg);
        this.o.log?.("account.refresh_failed", { status: res.status });
        throw new Error(msg);
      }
      const body = (await res.json()) as {
        access_token: string;
        refresh_token?: string;
        id_token?: string;
        expires_in?: number;
      };
      const next: TokenSet = {
        accessToken: body.access_token,
        refreshToken: body.refresh_token ?? cur.refreshToken,
        idToken: body.id_token ?? cur.idToken,
        expiresAt: Date.now() + (body.expires_in ?? 3600) * 1000,
        accountId: cur.accountId,
      };
      this.writeTokens(id, next);
      return next.accessToken;
    })();
    this.refreshing.set(id, p);
    try {
      return await p;
    } finally {
      this.refreshing.delete(id);
    }
  }

  // ---------- 登录流程 ----------

  private gc(): void {
    const now = Date.now();
    for (const [k, a] of this.attempts) {
      if (a.expiresAt < now) {
        if (a.dto.status === "pending") a.dto.status = "expired";
        if (a.expiresAt + ATTEMPT_TTL_MS < now) this.attempts.delete(k);
      }
    }
  }

  async start(method: "browser" | "device"): Promise<LoginAttempt> {
    this.gc();
    const attemptId = newId("login");
    if (method === "browser") {
      const verifier = b64url(randomBytes(32));
      const challenge = b64url(createHash("sha256").update(verifier).digest());
      const state = b64url(randomBytes(24));
      await this.ensureCallbackServer();
      const redirect = `http://localhost:${CALLBACK_PORT}/auth/callback`;
      const url = new URL(`${this.issuer}/oauth/authorize`);
      url.search = new URLSearchParams({
        response_type: "code",
        client_id: CHATGPT_CLIENT_ID,
        redirect_uri: redirect,
        scope: SCOPE,
        code_challenge: challenge,
        code_challenge_method: "S256",
        id_token_add_organizations: "true",
        codex_cli_simplified_flow: "true",
        originator: "codex_cli_rs",
        state,
      }).toString();
      const dto: LoginAttempt = {
        attemptId,
        method,
        status: "pending",
        authorizeUrl: url.toString(),
      };
      this.attempts.set(attemptId, {
        dto,
        verifier,
        state,
        expiresAt: Date.now() + ATTEMPT_TTL_MS,
      });
      return dto;
    }
    const res = await this.fetch(`${this.issuer}/api/accounts/deviceauth/usercode`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ client_id: CHATGPT_CLIENT_ID }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) {
      throw new Error(
        res.status === 404
          ? "该服务未开放设备码登录，请改用浏览器登录"
          : `获取设备码失败：HTTP ${res.status}`,
      );
    }
    const body = (await res.json()) as {
      device_auth_id: string;
      user_code?: string;
      usercode?: string;
      interval?: string | number;
    };
    const dto: LoginAttempt = {
      attemptId,
      method,
      status: "pending",
      verificationUrl: `${this.issuer}/codex/device`,
      userCode: body.user_code ?? body.usercode ?? "",
    };
    this.attempts.set(attemptId, {
      dto,
      deviceAuthId: body.device_auth_id,
      interval: Number(body.interval ?? 5),
      expiresAt: Date.now() + ATTEMPT_TTL_MS,
    });
    return dto;
  }

  /** 轮询：浏览器方式看回调是否已完成；设备码方式向令牌端点查询一次。 */
  async poll(attemptId: string): Promise<LoginAttempt | undefined> {
    this.gc();
    const a = this.attempts.get(attemptId);
    if (!a) return undefined;
    if (a.dto.status !== "pending" || a.dto.method === "browser") return a.dto;
    const res = await this.fetch(`${this.issuer}/api/accounts/deviceauth/token`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ device_auth_id: a.deviceAuthId, user_code: a.dto.userCode }),
      signal: AbortSignal.timeout(30_000),
    });
    if (res.status === 403 || res.status === 404) return a.dto; // 用户尚未完成授权
    if (!res.ok) {
      a.dto.status = "failed";
      a.dto.error = `设备码登录失败：HTTP ${res.status}`;
      return a.dto;
    }
    const body = (await res.json()) as { authorization_code: string; code_verifier: string };
    await this.finish(
      a,
      body.authorization_code,
      body.code_verifier,
      `${this.issuer}/deviceauth/callback`,
    );
    return a.dto;
  }

  private async finish(
    a: Attempt,
    code: string,
    verifier: string,
    redirectUri: string,
  ): Promise<void> {
    try {
      const res = await this.fetch(`${this.issuer}/oauth/token`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          code,
          redirect_uri: redirectUri,
          client_id: CHATGPT_CLIENT_ID,
          code_verifier: verifier,
        }).toString(),
        signal: AbortSignal.timeout(30_000),
      });
      if (!res.ok) throw new Error(`令牌交换失败：HTTP ${res.status}`);
      const body = (await res.json()) as {
        access_token: string;
        refresh_token: string;
        id_token?: string;
        expires_in?: number;
      };
      const tokens: TokenSet = {
        accessToken: body.access_token,
        refreshToken: body.refresh_token,
        idToken: body.id_token,
        expiresAt: Date.now() + (body.expires_in ?? 3600) * 1000,
      };
      tokens.accountId = identity(tokens).accountId;
      const id = this.writeTokens(undefined, tokens);
      const account = this.get(id) as Account;
      a.dto.status = "succeeded";
      a.dto.account = account;
      a.dto.profileIds = this.o.onLoggedIn(account);
      this.o.log?.("account.login", { method: a.dto.method });
    } catch (e) {
      a.dto.status = "failed";
      a.dto.error = redactSecrets(e instanceof Error ? e.message : String(e));
    } finally {
      this.maybeStopCallbackServer();
    }
  }

  /** 本机回调服务（只监听 127.0.0.1，按 state 匹配登录尝试）。 */
  private ensureCallbackServer(): Promise<void> {
    if (this.callback) return Promise.resolve();
    const server = createServer((req, res) => {
      const url = new URL(req.url ?? "/", `http://localhost:${CALLBACK_PORT}`);
      if (url.pathname !== "/auth/callback") {
        res.writeHead(404).end();
        return;
      }
      const state = url.searchParams.get("state");
      const code = url.searchParams.get("code");
      const entry = [...this.attempts.values()].find(
        (x) => x.state !== undefined && x.state === state,
      );
      const page = (title: string, text: string) => {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        res.end(
          `<!doctype html><meta charset="utf-8"><title>${title}</title><body style="font-family:system-ui;padding:48px"><h2>${title}</h2><p>${text}</p></body>`,
        );
      };
      if (!entry || entry.dto.status !== "pending" || !entry.verifier) {
        page("登录失败", "登录请求无效或已过期，请回到 ExcelManus 重新开始登录。");
        return;
      }
      if (!code) {
        entry.dto.status = "failed";
        entry.dto.error = url.searchParams.get("error_description") ?? "授权被取消";
        page("登录未完成", "授权被取消，可以关闭此页面。");
        this.maybeStopCallbackServer();
        return;
      }
      void this.finish(
        entry,
        code,
        entry.verifier,
        `http://localhost:${CALLBACK_PORT}/auth/callback`,
      ).then(() =>
        entry.dto.status === "succeeded"
          ? page("登录成功", "已完成 ChatGPT 账号登录，可以关闭此页面并回到 ExcelManus。")
          : page("登录失败", entry.dto.error ?? "未知错误"),
      );
    });
    return new Promise((resolve, reject) => {
      server.once("error", (e: NodeJS.ErrnoException) => {
        reject(
          new Error(
            e.code === "EADDRINUSE"
              ? `本机端口 ${CALLBACK_PORT} 被占用（可能有其他 Codex 登录在进行），请稍后重试或改用设备码登录`
              : e.message,
          ),
        );
      });
      server.listen(CALLBACK_PORT, "127.0.0.1", () => {
        this.callback = server;
        resolve();
      });
    });
  }

  private maybeStopCallbackServer(): void {
    const pending = [...this.attempts.values()].some(
      (a) => a.dto.method === "browser" && a.dto.status === "pending",
    );
    if (!pending && this.callback) {
      this.callback.close();
      this.callback = undefined;
    }
  }

  close(): void {
    this.callback?.close();
    this.callback = undefined;
  }
}
