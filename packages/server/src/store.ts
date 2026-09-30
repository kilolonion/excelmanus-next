// 配置与状态的数据访问（直接 node:sqlite 预编译语句，ADR 0006）。

import { createHash, randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { newId, nowIso } from "@excelmanus/core";
import type {
  ClassifiedError,
  CreateModelProfileBody,
  ModelProfile,
  ResolvedModel,
  UpdateModelProfileBody,
} from "@excelmanus/protocol";
import { decryptSecret, encryptSecret, maskSecret } from "./crypto.ts";

export const sha256 = (s: string): string => createHash("sha256").update(s).digest("hex");

// ---------- devices / token ----------

export function ensureDeviceToken(dataDir: string, db: DatabaseSync): string {
  const tokenPath = join(dataDir, "local-token");
  if (existsSync(tokenPath)) {
    const token = readFileSync(tokenPath, "utf8").trim();
    const row = db
      .prepare("SELECT id FROM devices WHERE token_hash = ? AND revoked_at IS NULL")
      .get(sha256(token));
    if (token !== "" && row) return token;
  }
  const token = randomBytes(32).toString("base64url");
  const existing = db
    .prepare("SELECT id FROM devices WHERE kind = 'local' AND revoked_at IS NULL")
    .get() as { id: string } | undefined;
  const id = existing?.id ?? newId("dev");
  db.prepare(
    `INSERT INTO devices (id, name, kind, token_hash, created_at) VALUES (?, ?, 'local', ?, ?)
     ON CONFLICT(id) DO UPDATE SET token_hash = excluded.token_hash`,
  ).run(id, "本机", sha256(token), nowIso());
  writeFileSync(tokenPath, token, { mode: 0o600 });
  return token;
}

// ---------- workspaces ----------

export interface WorkspaceRow {
  id: string;
  name: string;
  path: string;
  is_default: number;
}

export function ensureWorkspace(
  db: DatabaseSync,
  opts: { name: string; path: string; isDefault?: boolean },
): WorkspaceRow {
  const found = db.prepare("SELECT * FROM workspaces WHERE path = ?").get(opts.path) as
    | WorkspaceRow
    | undefined;
  if (found) return found;
  const id = newId("wks");
  db.prepare(
    "INSERT INTO workspaces (id, name, path, is_default, sort, created_at) VALUES (?, ?, ?, ?, 0, ?)",
  ).run(id, opts.name, opts.path, opts.isDefault ? 1 : 0, nowIso());
  return { id, name: opts.name, path: opts.path, is_default: opts.isDefault ? 1 : 0 };
}

export function defaultWorkspace(db: DatabaseSync): WorkspaceRow | undefined {
  return (
    (db.prepare("SELECT * FROM workspaces WHERE is_default = 1 ORDER BY sort LIMIT 1").get() as
      | WorkspaceRow
      | undefined) ??
    (db.prepare("SELECT * FROM workspaces ORDER BY sort LIMIT 1").get() as WorkspaceRow | undefined)
  );
}

export function getWorkspace(db: DatabaseSync, id: string): WorkspaceRow | undefined {
  return db.prepare("SELECT * FROM workspaces WHERE id = ?").get(id) as WorkspaceRow | undefined;
}

// ---------- model profiles ----------

interface ProfileRow {
  id: string;
  name: string;
  provider: string;
  model: string;
  base_url: string | null;
  credential_id: string | null;
  context_window: number | null;
  max_output_tokens: number | null;
  reasoning: string | null;
  provider_options: string | null;
  is_default: number;
  created_at: string;
  updated_at: string;
}

interface CredentialRow {
  id: string;
  ciphertext: Buffer;
  nonce: Buffer;
}

function profileToDto(row: ProfileRow, masked: string | null): ModelProfile {
  return {
    id: row.id,
    name: row.name,
    provider: row.provider,
    model: row.model,
    ...(row.base_url !== null ? { baseUrl: row.base_url } : {}),
    hasCredential: row.credential_id !== null,
    apiKeyMasked: masked,
    ...(row.context_window !== null ? { contextWindow: row.context_window } : {}),
    ...(row.max_output_tokens !== null ? { maxOutputTokens: row.max_output_tokens } : {}),
    ...(row.reasoning !== null ? { reasoning: row.reasoning as ModelProfile["reasoning"] } : {}),
    ...(row.provider_options !== null
      ? { providerOptions: JSON.parse(row.provider_options) as Record<string, unknown> }
      : {}),
    isDefault: row.is_default === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function listProfiles(db: DatabaseSync, masterKey: Buffer): ModelProfile[] {
  const rows = db
    .prepare("SELECT * FROM model_profiles ORDER BY created_at")
    .all() as unknown as ProfileRow[];
  return rows.map((r) => profileToDto(r, maskedOf(db, masterKey, r.credential_id)));
}

function maskedOf(db: DatabaseSync, masterKey: Buffer, credentialId: string | null): string | null {
  if (credentialId === null) return null;
  const cred = db
    .prepare("SELECT ciphertext, nonce FROM credentials WHERE id = ?")
    .get(credentialId) as CredentialRow | undefined;
  if (!cred) return null;
  try {
    return maskSecret(
      decryptSecret(masterKey, Buffer.from(cred.ciphertext), Buffer.from(cred.nonce)),
    );
  } catch {
    return "••••";
  }
}

export function getProfileRow(db: DatabaseSync, id: string): ProfileRow | undefined {
  return db.prepare("SELECT * FROM model_profiles WHERE id = ?").get(id) as ProfileRow | undefined;
}

export function getProfile(
  db: DatabaseSync,
  masterKey: Buffer,
  id: string,
): ModelProfile | undefined {
  const row = getProfileRow(db, id);
  return row ? profileToDto(row, maskedOf(db, masterKey, row.credential_id)) : undefined;
}

export function createProfile(
  db: DatabaseSync,
  masterKey: Buffer,
  body: CreateModelProfileBody,
): ModelProfile {
  const now = nowIso();
  let credentialId: string | null = null;
  if (body.apiKey !== undefined && body.apiKey !== "") {
    const { ciphertext, nonce } = encryptSecret(masterKey, body.apiKey);
    credentialId = newId("cred");
    db.prepare(
      "INSERT INTO credentials (id, kind, provider, ciphertext, nonce, meta, created_at, updated_at) VALUES (?, 'api_key', ?, ?, ?, '{}', ?, ?)",
    ).run(credentialId, body.provider, ciphertext, nonce, now, now);
  }
  const id = newId("mp");
  db.prepare(
    `INSERT INTO model_profiles (id, name, provider, model, base_url, credential_id, context_window, max_output_tokens, reasoning, provider_options, is_default, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`,
  ).run(
    id,
    body.name,
    body.provider,
    body.model,
    body.baseUrl ?? null,
    credentialId,
    body.contextWindow ?? null,
    body.maxOutputTokens ?? null,
    body.reasoning ?? null,
    body.providerOptions !== undefined ? JSON.stringify(body.providerOptions) : null,
    now,
    now,
  );
  if (body.isDefault || countProfiles(db) === 1) {
    setDefaultProfile(db, id);
  }
  const row = getProfileRow(db, id);
  if (!row) throw new Error("profile insert failed");
  return profileToDto(row, maskedOf(db, masterKey, row.credential_id));
}

function countProfiles(db: DatabaseSync): number {
  return (db.prepare("SELECT COUNT(*) AS c FROM model_profiles").get() as { c: number }).c;
}

export function updateProfile(
  db: DatabaseSync,
  masterKey: Buffer,
  id: string,
  body: UpdateModelProfileBody,
): ModelProfile | undefined {
  const row = getProfileRow(db, id);
  if (!row) return undefined;
  const now = nowIso();
  let credentialId = row.credential_id;
  if (body.apiKey !== undefined) {
    // 清除旧凭据
    if (credentialId !== null) {
      db.prepare("DELETE FROM credentials WHERE id = ?").run(credentialId);
      credentialId = null;
    }
    if (body.apiKey !== "") {
      const { ciphertext, nonce } = encryptSecret(masterKey, body.apiKey);
      credentialId = newId("cred");
      db.prepare(
        "INSERT INTO credentials (id, kind, provider, ciphertext, nonce, meta, created_at, updated_at) VALUES (?, 'api_key', ?, ?, ?, '{}', ?, ?)",
      ).run(credentialId, body.provider ?? row.provider, ciphertext, nonce, now, now);
    }
  }
  db.prepare(
    `UPDATE model_profiles SET
       name = COALESCE(?, name),
       provider = COALESCE(?, provider),
       model = COALESCE(?, model),
       base_url = CASE WHEN ? THEN ? ELSE base_url END,
       credential_id = ?,
       context_window = CASE WHEN ? THEN ? ELSE context_window END,
       max_output_tokens = CASE WHEN ? THEN ? ELSE max_output_tokens END,
       reasoning = CASE WHEN ? THEN ? ELSE reasoning END,
       provider_options = CASE WHEN ? THEN ? ELSE provider_options END,
       updated_at = ?
     WHERE id = ?`,
  ).run(
    body.name ?? null,
    body.provider ?? null,
    body.model ?? null,
    body.baseUrl !== undefined ? 1 : 0,
    body.baseUrl ?? null,
    credentialId,
    body.contextWindow !== undefined ? 1 : 0,
    body.contextWindow ?? null,
    body.maxOutputTokens !== undefined ? 1 : 0,
    body.maxOutputTokens ?? null,
    body.reasoning !== undefined ? 1 : 0,
    body.reasoning ?? null,
    body.providerOptions !== undefined ? 1 : 0,
    body.providerOptions != null ? JSON.stringify(body.providerOptions) : null,
    now,
    id,
  );
  const updated = getProfileRow(db, id);
  return updated
    ? profileToDto(updated, maskedOf(db, masterKey, updated.credential_id))
    : undefined;
}

export function deleteProfile(db: DatabaseSync, id: string): boolean {
  const row = getProfileRow(db, id);
  if (!row) return false;
  if (row.credential_id !== null) {
    db.prepare("DELETE FROM credentials WHERE id = ?").run(row.credential_id);
  }
  db.prepare("DELETE FROM model_profiles WHERE id = ?").run(id);
  return true;
}

export function setDefaultProfile(db: DatabaseSync, id: string): void {
  db.exec("UPDATE model_profiles SET is_default = 0");
  db.prepare("UPDATE model_profiles SET is_default = 1 WHERE id = ?").run(id);
}

export function defaultProfileId(db: DatabaseSync): string | null {
  const row = db.prepare("SELECT id FROM model_profiles WHERE is_default = 1 LIMIT 1").get() as
    | { id: string }
    | undefined;
  return row?.id ?? null;
}

/** 档案 → ResolvedModel（解密凭据）；未配置/凭据缺失返回错误。 */
export function resolveProfileModel(
  db: DatabaseSync,
  masterKey: Buffer,
  profileId: string | null,
): ResolvedModel | { error: ClassifiedError } {
  const row =
    profileId !== null
      ? getProfileRow(db, profileId)
      : (db.prepare("SELECT * FROM model_profiles WHERE is_default = 1 LIMIT 1").get() as
          | ProfileRow
          | undefined);
  if (!row) {
    return {
      error: {
        kind: "invalid_request",
        retryable: false,
        message: "未配置模型档案：请先在设置中添加模型档案",
      },
    };
  }
  let apiKey = "";
  if (row.credential_id !== null) {
    const cred = db
      .prepare("SELECT ciphertext, nonce FROM credentials WHERE id = ?")
      .get(row.credential_id) as CredentialRow | undefined;
    if (!cred) {
      return {
        error: {
          kind: "auth",
          retryable: false,
          message: "模型档案引用的凭据不存在，请重新填写 API Key",
        },
      };
    }
    try {
      apiKey = decryptSecret(masterKey, Buffer.from(cred.ciphertext), Buffer.from(cred.nonce));
    } catch {
      return {
        error: {
          kind: "auth",
          retryable: false,
          message: "凭据解密失败（主密钥可能已更换），请重新填写 API Key",
        },
      };
    }
  }
  return {
    profileId: row.id,
    provider: row.provider,
    model: row.model,
    ...(row.base_url !== null ? { baseUrl: row.base_url } : {}),
    apiKey,
    ...(row.context_window !== null ? { contextWindow: row.context_window } : {}),
    ...(row.provider_options !== null
      ? { providerOptions: JSON.parse(row.provider_options) as Record<string, unknown> }
      : {}),
    ...(row.reasoning !== null ? { reasoning: row.reasoning } : {}),
  };
}

// ---------- sessions ----------

export interface SessionRow {
  id: string;
  workspace_id: string;
  title: string | null;
  permission_mode: string;
  created_at: string;
  updated_at: string;
  last_seq: number;
}

export function getSession(db: DatabaseSync, id: string): SessionRow | undefined {
  return db.prepare("SELECT * FROM sessions WHERE id = ?").get(id) as SessionRow | undefined;
}

export interface AgentRowOut {
  id: string;
  session_id: string;
  parent_id: string | null;
  name: string | null;
  role: string;
  status: string;
  model_profile_id: string | null;
}

export function listAgents(db: DatabaseSync, sessionId: string): AgentRowOut[] {
  return db
    .prepare("SELECT * FROM agents WHERE session_id = ? ORDER BY created_at")
    .all(sessionId) as unknown as AgentRowOut[];
}

export function deleteSessionData(db: DatabaseSync, sessionId: string): void {
  db.exec("BEGIN IMMEDIATE");
  try {
    db.prepare("DELETE FROM session_log WHERE session_id = ?").run(sessionId);
    db.prepare("DELETE FROM sessions WHERE id = ?").run(sessionId);
    db.prepare("DELETE FROM agents WHERE session_id = ?").run(sessionId);
    db.prepare("DELETE FROM agent_context WHERE session_id = ?").run(sessionId);
    db.prepare("DELETE FROM dispatches WHERE session_id = ?").run(sessionId);
    db.prepare("DELETE FROM open_intents WHERE session_id = ?").run(sessionId);
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}
