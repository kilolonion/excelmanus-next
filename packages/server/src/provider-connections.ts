// 供应商连接是 URL、认证和目录缓存的唯一配置来源。
import { existsSync } from "node:fs";
import type { DatabaseSync } from "node:sqlite";
import { newId, nowIso } from "@excelmanus/core";
import { presetFor } from "@excelmanus/models";
import type {
  CreateProviderConnectionBody,
  ProviderConnection,
  UpdateProviderConnectionBody,
} from "@excelmanus/protocol";
import { decryptSecret, encryptSecret, maskSecret } from "./crypto.ts";

export interface ConnectionRow {
  id: string;
  name: string;
  provider: string;
  base_url: string | null;
  credential_id: string | null;
  extra_headers: string | null;
  models_cache: string | null;
  models_updated_at: string | null;
  created_at: string;
  updated_at: string;
}
export function openConnectionHeaders(
  key: Buffer,
  raw: string | null | undefined,
): Record<string, string> | undefined {
  if (!raw) return undefined;
  return Object.fromEntries(
    Object.entries(JSON.parse(raw) as Record<string, string>).map(([name, value]) => {
      const [nonce, ciphertext] = value.split(".");
      return [
        name,
        decryptSecret(
          key,
          Buffer.from(ciphertext ?? "", "base64"),
          Buffer.from(nonce ?? "", "base64"),
        ),
      ];
    }),
  );
}
export function sealConnectionHeaders(
  key: Buffer,
  headers: Record<string, string>,
  prev?: Record<string, string>,
): string {
  return JSON.stringify(
    Object.fromEntries(
      Object.entries(headers).map(([name, value]) => {
        const plain = value === "••••" && prev?.[name] !== undefined ? prev[name] : value;
        const s = encryptSecret(key, plain);
        return [name, `${s.nonce.toString("base64")}.${s.ciphertext.toString("base64")}`];
      }),
    ),
  );
}
const MARKER = "provider_connections_v1";
/** Called under the instance lock, before configuration is read. DDL/backfill are one transaction. */
export function migrateProviderConnections(db: DatabaseSync, masterKey: Buffer): void {
  if (db.prepare("SELECT value FROM meta WHERE key=?").get(MARKER)) return;
  const location = (
    db.prepare("PRAGMA database_list").all() as { name: string; file: string }[]
  ).find((x) => x.name === "main")?.file;
  if (location && existsSync(location)) {
    // VACUUM INTO includes committed WAL pages, unlike copying only the main file.
    db.prepare("VACUUM INTO ?").run(
      `${location}.provider-connections-${Date.now()}-${newId("bak")}.bak`,
    );
  }
  db.exec("BEGIN IMMEDIATE");
  try {
    db.exec(`CREATE TABLE provider_connections (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, provider TEXT NOT NULL,
      base_url TEXT, credential_id TEXT REFERENCES credentials(id), extra_headers TEXT,
      models_cache TEXT, models_updated_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    ALTER TABLE model_profiles ADD COLUMN connection_id TEXT REFERENCES provider_connections(id);`);
    const old = db
      .prepare("SELECT * FROM model_profiles ORDER BY created_at,id")
      .all() as unknown as (ConnectionRow & { model: string })[];
    const groups = new Map<string, string>();
    for (const row of old) {
      let credentialIdentity: unknown = null;
      if (row.credential_id) {
        const credential = db
          .prepare("SELECT kind,ciphertext,nonce FROM credentials WHERE id=?")
          .get(row.credential_id) as
          | { kind: string; ciphertext: Uint8Array; nonce: Uint8Array }
          | undefined;
        if (!credential) throw new Error("旧模型的凭据不存在，连接迁移已中止");
        credentialIdentity =
          credential.kind === "oauth"
            ? ["oauth", row.credential_id]
            : [
                credential.kind,
                decryptSecret(
                  masterKey,
                  Buffer.from(credential.ciphertext),
                  Buffer.from(credential.nonce),
                ),
              ];
      }
      const headers = openConnectionHeaders(masterKey, row.extra_headers);
      const preset = presetFor(row.provider);
      const url =
        row.base_url ??
        preset?.defaultBaseUrl ??
        (
          {
            openai: "https://api.openai.com/v1",
            anthropic: "https://api.anthropic.com/v1",
            google: "https://generativelanguage.googleapis.com/v1beta",
          } as Record<string, string>
        )[row.provider] ??
        null;
      const identity = JSON.stringify(
        row.provider === "chatgpt"
          ? [row.provider, credentialIdentity]
          : [
              row.provider,
              url?.replace(/\/$/, ""),
              credentialIdentity,
              Object.entries(headers ?? {}).sort(([a], [b]) => a.localeCompare(b)),
            ],
      );
      let id = groups.get(identity);
      if (!id) {
        id = newId("pc");
        groups.set(identity, id);
        const name = row.name || preset?.displayName || row.provider;
        db.prepare(
          "INSERT INTO provider_connections (id,name,provider,base_url,credential_id,extra_headers,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)",
        ).run(
          id,
          name,
          row.provider,
          row.base_url,
          row.credential_id,
          row.extra_headers,
          row.created_at,
          row.updated_at,
        );
      }
      db.prepare("UPDATE model_profiles SET connection_id=? WHERE id=?").run(id, row.id);
    }
    // Keep profile IDs/table identity and their external references intact.
    for (const column of ["provider", "base_url", "credential_id", "extra_headers"])
      db.exec(`ALTER TABLE model_profiles DROP COLUMN ${column}`);
    db.exec(`CREATE TRIGGER model_connection_required_insert BEFORE INSERT ON model_profiles WHEN NEW.connection_id IS NULL BEGIN SELECT RAISE(ABORT,'模型必须关联供应商连接'); END;
      CREATE TRIGGER model_connection_required_update BEFORE UPDATE OF connection_id ON model_profiles WHEN NEW.connection_id IS NULL BEGIN SELECT RAISE(ABORT,'模型必须关联供应商连接'); END;`);
    db.prepare("INSERT INTO meta (key,value) VALUES (?,?)").run(MARKER, nowIso());
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

export function getConnectionRow(db: DatabaseSync, id: string): ConnectionRow | undefined {
  return db.prepare("SELECT * FROM provider_connections WHERE id=?").get(id) as unknown as
    | ConnectionRow
    | undefined;
}

export function getConnection(
  db: DatabaseSync,
  key: Buffer,
  id: string,
): ProviderConnection | undefined {
  const row = getConnectionRow(db, id);
  if (!row) return undefined;
  const credential = row.credential_id
    ? (db
        .prepare("SELECT kind,ciphertext,nonce FROM credentials WHERE id=?")
        .get(row.credential_id) as
        | { kind: string; ciphertext: Uint8Array; nonce: Uint8Array }
        | undefined)
    : undefined;
  const headers = row.extra_headers
    ? (JSON.parse(row.extra_headers) as Record<string, string>)
    : undefined;
  return {
    id: row.id,
    name: row.name,
    provider: row.provider,
    ...(row.base_url ? { baseUrl: row.base_url } : {}),
    hasCredential: !!credential,
    apiKeyMasked:
      credential && credential.kind !== "oauth"
        ? maskSecret(
            decryptSecret(key, Buffer.from(credential.ciphertext), Buffer.from(credential.nonce)),
          )
        : null,
    accountId: credential?.kind === "oauth" ? row.credential_id : null,
    ...(headers
      ? { extraHeaders: Object.fromEntries(Object.keys(headers).map((k) => [k, "••••"])) }
      : {}),
    modelCount: (
      db.prepare("SELECT count(*) AS n FROM model_profiles WHERE connection_id=?").get(id) as {
        n: number;
      }
    ).n,
    modelsUpdatedAt: row.models_updated_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
export function listConnections(db: DatabaseSync, key: Buffer): ProviderConnection[] {
  return (
    db.prepare("SELECT id FROM provider_connections ORDER BY created_at,id").all() as {
      id: string;
    }[]
  ).map((r) => getConnection(db, key, r.id)!);
}
function insertKey(db: DatabaseSync, key: Buffer, provider: string, value: string): string {
  const id = newId("cred"),
    now = nowIso(),
    sealed = encryptSecret(key, value);
  db.prepare(
    "INSERT INTO credentials (id,kind,provider,ciphertext,nonce,meta,created_at,updated_at) VALUES (?,'api_key',?,?,?,'{}',?,?)",
  ).run(id, provider, sealed.ciphertext, sealed.nonce, now, now);
  return id;
}
export function createConnection(
  db: DatabaseSync,
  key: Buffer,
  body: CreateProviderConnectionBody,
): ProviderConnection {
  if (!presetFor(body.provider)) throw new Error("未知供应商接口类型");
  if (
    body.accountId &&
    db.prepare("SELECT kind FROM credentials WHERE id=?").get(body.accountId)?.kind !== "oauth"
  )
    throw new Error("订阅账号不存在");
  if (body.provider === "chatgpt" && !body.accountId)
    throw new Error("请先在订阅账号页登录 ChatGPT");
  if (body.accountId && body.provider !== "chatgpt")
    throw new Error("订阅账号必须使用 ChatGPT 接口");
  if (body.accountId && body.apiKey) throw new Error("订阅连接不使用 API Key");
  const id = newId("pc"),
    now = nowIso();
  db.exec("BEGIN IMMEDIATE");
  try {
    const credentialId =
      body.accountId ?? (body.apiKey ? insertKey(db, key, body.provider, body.apiKey) : null);
    db.prepare(
      "INSERT INTO provider_connections (id,name,provider,base_url,credential_id,extra_headers,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)",
    ).run(
      id,
      body.name,
      body.provider,
      body.baseUrl || null,
      credentialId,
      body.extraHeaders ? sealConnectionHeaders(key, body.extraHeaders) : null,
      now,
      now,
    );
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  return getConnection(db, key, id)!;
}
export function updateConnection(
  db: DatabaseSync,
  key: Buffer,
  id: string,
  body: UpdateProviderConnectionBody,
): ProviderConnection | undefined {
  const row = getConnectionRow(db, id);
  if (!row) return undefined;
  if (row.provider === "chatgpt" && body.apiKey !== undefined)
    throw new Error("订阅凭据由账号页管理");
  const changesConfig =
    body.baseUrl !== undefined || body.apiKey !== undefined || body.extraHeaders !== undefined;
  db.exec("BEGIN IMMEDIATE");
  try {
    const credentialId =
      body.apiKey === undefined
        ? row.credential_id
        : body.apiKey
          ? insertKey(db, key, row.provider, body.apiKey)
          : null;
    const headers =
      body.extraHeaders === undefined
        ? row.extra_headers
        : body.extraHeaders === null
          ? null
          : sealConnectionHeaders(
              key,
              body.extraHeaders,
              openConnectionHeaders(key, row.extra_headers),
            );
    db.prepare(
      "UPDATE provider_connections SET name=?,base_url=?,credential_id=?,extra_headers=?,updated_at=? WHERE id=?",
    ).run(
      body.name ?? row.name,
      body.baseUrl === undefined ? row.base_url : body.baseUrl || null,
      credentialId,
      headers,
      nowIso(),
      id,
    );
    if (changesConfig) {
      db.prepare(
        "UPDATE provider_connections SET models_cache=NULL,models_updated_at=NULL WHERE id=?",
      ).run(id);
      const profiles = db
        .prepare("SELECT id,capabilities FROM model_profiles WHERE connection_id=?")
        .all(id) as { id: string; capabilities: string | null }[];
      for (const p of profiles) {
        const caps = p.capabilities
          ? (JSON.parse(p.capabilities) as Record<string, { source?: string }>)
          : {};
        const manual = Object.fromEntries(
          Object.entries(caps).filter(([, v]) => v?.source === "manual"),
        );
        db.prepare("UPDATE model_profiles SET capabilities=?,updated_at=? WHERE id=?").run(
          JSON.stringify(manual),
          nowIso(),
          p.id,
        );
      }
    }
    if (row.credential_id && row.credential_id !== credentialId)
      db.prepare(
        "DELETE FROM credentials WHERE id=? AND kind='api_key' AND NOT EXISTS (SELECT 1 FROM provider_connections WHERE credential_id=?)",
      ).run(row.credential_id, row.credential_id);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  return getConnection(db, key, id);
}
export function deleteConnection(db: DatabaseSync, id: string): boolean {
  const row = getConnectionRow(db, id);
  if (!row) return false;
  if (db.prepare("SELECT 1 FROM model_profiles WHERE connection_id=?").get(id))
    throw new Error("请先移走或删除该供应商下的模型");
  db.exec("BEGIN IMMEDIATE");
  try {
    db.prepare("DELETE FROM provider_connections WHERE id=?").run(id);
    if (row.credential_id)
      db.prepare(
        "DELETE FROM credentials WHERE id=? AND kind='api_key' AND NOT EXISTS (SELECT 1 FROM provider_connections WHERE credential_id=?)",
      ).run(row.credential_id, row.credential_id);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  return true;
}
