import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { KERNEL_MIGRATIONS, openDb } from "@excelmanus/kernel";
import { createApiClient } from "@excelmanus/protocol";
import { afterEach, expect, test } from "vitest";
import { encryptSecret } from "../src/crypto.ts";
import { startServer } from "../src/index.ts";
import { migrateProviderConnections } from "../src/provider-connections.ts";
import { SERVER_MIGRATIONS } from "../src/store.ts";

const dirs: string[] = [];
const key = Buffer.alloc(32, 7);
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
function legacy() {
  const dir = mkdtempSync(join(tmpdir(), "em-connections-"));
  dirs.push(dir);
  const db = openDb(join(dir, "test.db"), [...KERNEL_MIGRATIONS, ...SERVER_MIGRATIONS]);
  function add(id: string, secret: string, headers?: Record<string, string>, kind = "api_key") {
    const { ciphertext, nonce } = encryptSecret(key, secret);
    db.prepare(
      "INSERT INTO credentials (id,kind,provider,ciphertext,nonce,meta,created_at,updated_at) VALUES (?,?,?,?,?,'{}','now','now')",
    ).run(`cred-${id}`, kind, "custom-openai-compatible", ciphertext, nonce);
    const sealed = headers
      ? JSON.stringify(
          Object.fromEntries(
            Object.entries(headers).map(([k, v]) => {
              const s = encryptSecret(key, v);
              return [k, `${s.nonce.toString("base64")}.${s.ciphertext.toString("base64")}`];
            }),
          ),
        )
      : null;
    db.prepare(
      "INSERT INTO model_profiles (id,name,provider,model,base_url,credential_id,context_window,max_output_tokens,is_default,extra_headers,created_at,updated_at) VALUES (?,?,?,?,'https://example.test/v1',?,64000,2048,?,?, 'now','now')",
    ).run(
      id,
      id,
      kind === "oauth" ? "chatgpt" : "custom-openai-compatible",
      `model-${id}`,
      `cred-${id}`,
      id === "a" ? 1 : 0,
      sealed,
    );
  }
  return { db, dir, add };
}
test("migration merges equal credentials, separates keys/headers, preserves profiles and repeats safely", () => {
  const { db, dir, add } = legacy();
  try {
    add("a", "test-one");
    add("b", "test-one");
    add("c", "test-two");
    add("d", "test-one", { "x-route": "other" });
    db.prepare("INSERT INTO settings (key,value,updated_at) VALUES ('binding',?,'now')").run(
      JSON.stringify({ modelProfileId: "a" }),
    );
    migrateProviderConnections(db, key);
    const rows = db
      .prepare(
        "SELECT id,connection_id,is_default,max_output_tokens FROM model_profiles ORDER BY id",
      )
      .all();
    expect(rows).toHaveLength(4);
    expect(rows[0]?.connection_id).toBe(rows[1]?.connection_id);
    expect(rows[0]?.connection_id).not.toBe(rows[2]?.connection_id);
    expect(rows[0]?.connection_id).not.toBe(rows[3]?.connection_id);
    expect(rows[0]).toMatchObject({ id: "a", is_default: 1, max_output_tokens: 2048 });
    expect(db.prepare("SELECT value FROM settings WHERE key='binding'").get()?.value).toBe(
      '{"modelProfileId":"a"}',
    );
    expect(db.prepare("SELECT id FROM provider_connections").all()).toHaveLength(3);
    expect(readdirSync(dir).some((x) => x.includes("provider-connections"))).toBe(true);
    migrateProviderConnections(db, key);
    expect(db.prepare("SELECT id FROM provider_connections").all()).toHaveLength(3);
    expect(
      db
        .prepare("PRAGMA table_info(model_profiles)")
        .all()
        .map((x) => x.name),
    ).not.toContain("credential_id");
  } finally {
    db.close();
  }
});
test("decryption failure rolls back structure and leaves old profiles intact", () => {
  const { db, add } = legacy();
  try {
    add("a", "test-one");
    expect(() => migrateProviderConnections(db, Buffer.alloc(32, 9))).toThrow();
    expect(
      db.prepare("SELECT credential_id FROM model_profiles WHERE id='a'").get()?.credential_id,
    ).toBe("cred-a");
    expect(
      db.prepare("SELECT name FROM sqlite_master WHERE name='provider_connections'").get(),
    ).toBeUndefined();
    migrateProviderConnections(db, key);
    expect(db.prepare("SELECT id FROM provider_connections").all()).toHaveLength(1);
  } finally {
    db.close();
  }
});
test("subscription models group by account rather than token equality", () => {
  const { db, add } = legacy();
  try {
    add("a", "same-oauth", undefined, "oauth");
    add("b", "same-oauth", undefined, "oauth");
    db.exec(
      "INSERT INTO model_profiles (id,name,provider,model,credential_id,created_at,updated_at) VALUES ('c','c','chatgpt','another','cred-a','now','now')",
    );
    migrateProviderConnections(db, key);
    const rows = db.prepare("SELECT id,connection_id FROM model_profiles ORDER BY id").all();
    expect(rows[0]?.connection_id).toBe(rows[2]?.connection_id);
    expect(rows[0]?.connection_id).not.toBe(rows[1]?.connection_id);
  } finally {
    db.close();
  }
});

test("connection CRUD preserves credentials on masked edit and refuses nonempty deletion", async () => {
  const { db, add } = legacy();
  try {
    add("a", "test-one");
    migrateProviderConnections(db, key);
    const { listConnections, createConnection, updateConnection, deleteConnection } = await import(
      "../src/provider-connections.ts"
    );
    const before = listConnections(db, key)[0]!;
    const created = createConnection(db, key, {
      name: "second",
      provider: "custom-openai-compatible",
      baseUrl: "https://another.test/v1",
      apiKey: "test-two",
    });
    expect(created.modelCount).toBe(0);
    updateConnection(db, key, before.id, { name: "renamed", baseUrl: "https://changed.test/v1" });
    expect(listConnections(db, key).find((x) => x.id === before.id)?.apiKeyMasked).toBe(
      before.apiKeyMasked,
    );
    expect(() => deleteConnection(db, before.id)).toThrow("模型");
    expect(deleteConnection(db, created.id)).toBe(true);
  } finally {
    db.close();
  }
});

test("models resolve shared connection changes and deleting one keeps sibling credentials", async () => {
  const { db } = legacy();
  try {
    migrateProviderConnections(db, key);
    const { createConnection, updateConnection } = await import("../src/provider-connections.ts");
    const { createProfile, resolveProfileModel, deleteProfile } = await import("../src/store.ts");
    const c = createConnection(db, key, {
      name: "shared",
      provider: "custom-openai-compatible",
      baseUrl: "https://one.test/v1",
      apiKey: "fixture-key",
    });
    const a = createProfile(db, key, { connectionId: c.id, model: "first" });
    const b = createProfile(db, key, { connectionId: c.id, model: "second" });
    updateConnection(db, key, c.id, { baseUrl: "https://two.test/v1" });
    expect(resolveProfileModel(db, key, a.id)).toMatchObject({
      baseUrl: "https://two.test/v1",
      apiKey: "fixture-key",
    });
    deleteProfile(db, a.id);
    expect(resolveProfileModel(db, key, b.id)).toMatchObject({
      baseUrl: "https://two.test/v1",
      apiKey: "fixture-key",
    });
  } finally {
    db.close();
  }
});

test("HTTP creates empty connection then models; shared edit and nonempty deletion", async () => {
  const dir = mkdtempSync(join(tmpdir(), "em-connection-http-"));
  dirs.push(dir);
  const server = await startServer({ dataDir: dir, log: () => {} });
  try {
    const api = createApiClient(server.url, server.token);
    const { connection } = await api.createProviderConnection({
      name: "Local test",
      provider: "custom-openai-compatible",
      baseUrl: "https://fixture.invalid/v1",
    });
    expect((await api.listProviderConnections()).items[0]?.modelCount).toBe(0);
    const { profile: a } = await api.createModelProfile({
      connectionId: connection.id,
      model: "one",
    });
    const { profile: b } = await api.createModelProfile({
      connectionId: connection.id,
      model: "two",
    });
    await api.updateProviderConnection(connection.id, { baseUrl: "https://changed.invalid/v1" });
    expect((await api.getModelProfile(a.id)).profile.baseUrl).toBe("https://changed.invalid/v1");
    expect((await api.getModelProfile(b.id)).profile.baseUrl).toBe("https://changed.invalid/v1");
    await expect(api.deleteProviderConnection(connection.id)).rejects.toThrow("模型");
    await expect(
      api.createModelProfile({
        connectionId: connection.id,
        model: "bad",
        contextWindow: 100,
        maxOutputTokens: 200,
      }),
    ).rejects.toThrow("最大输出");
  } finally {
    await server.close();
  }
});

test("catalog defaults flow into limits; explicit overrides and clearing retain automatic behavior", async () => {
  const { db } = legacy();
  try {
    migrateProviderConnections(db, key);
    const { createConnection } = await import("../src/provider-connections.ts");
    const { createProfile, resolveProfileModel, updateProfile } = await import("../src/store.ts");
    const c = createConnection(db, key, {
      name: "cached",
      provider: "custom-openai-compatible",
      baseUrl: "https://fixture.invalid",
    });
    db.prepare("UPDATE provider_connections SET models_cache=? WHERE id=?").run(
      JSON.stringify([{ id: "model", contextWindow: 64000, maxOutputTokens: 4096 }]),
      c.id,
    );
    const p = createProfile(db, key, { connectionId: c.id, model: "model" });
    expect(resolveProfileModel(db, key, p.id)).toMatchObject({
      contextWindow: 64000,
      maxOutputTokens: 4096,
    });
    updateProfile(db, key, p.id, { maxOutputTokens: 2048 });
    expect(resolveProfileModel(db, key, p.id)).toMatchObject({ maxOutputTokens: 2048 });
    updateProfile(db, key, p.id, { maxOutputTokens: null });
    expect(resolveProfileModel(db, key, p.id)).toMatchObject({ maxOutputTokens: 4096 });
    expect(() => updateProfile(db, key, p.id, { contextWindow: 1024 })).toThrow("最大输出");
  } finally {
    db.close();
  }
});

test("failed catalog refresh keeps previous list; edited connection invalidates only derived data", async () => {
  const dir = mkdtempSync(join(tmpdir(), "em-catalog-http-"));
  dirs.push(dir);
  let broken = false;
  const server = await startServer({
    dataDir: dir,
    log: () => {},
    fetchImpl: async () =>
      broken
        ? new Response("offline", { status: 503 })
        : Response.json({ data: [{ id: "fixture-model" }] }),
  });
  try {
    const api = createApiClient(server.url, server.token);
    const { connection } = await api.createProviderConnection({
      name: "Catalog",
      provider: "custom-openai-compatible",
      baseUrl: "https://fixture.invalid/v1",
    });
    expect((await api.refreshConnectionModels(connection.id)).items).toEqual([
      { id: "fixture-model" },
    ]);
    broken = true;
    await expect(api.refreshConnectionModels(connection.id)).rejects.toThrow();
    expect((await api.getConnectionModels(connection.id)).items).toEqual([{ id: "fixture-model" }]);
    const { profile } = await api.createModelProfile({
      connectionId: connection.id,
      model: "fixture-model",
      capabilityOverrides: { vision: false },
    });
    await api.updateProviderConnection(connection.id, { baseUrl: "https://changed.invalid/v1" });
    expect((await api.getConnectionModels(connection.id)).items).toEqual([]);
    expect((await api.getCapabilities(profile.id)).capabilities.vision).toMatchObject({
      source: "manual",
      value: false,
    });
  } finally {
    await server.close();
  }
});

test("referenced models cannot be deleted without replacing their settings binding", async () => {
  const { db } = legacy();
  try {
    migrateProviderConnections(db, key);
    const { createConnection } = await import("../src/provider-connections.ts");
    const { createProfile, deleteProfile } = await import("../src/store.ts");
    const c = createConnection(db, key, { name: "binding", provider: "custom-openai-compatible" });
    const p = createProfile(db, key, { connectionId: c.id, model: "bound" });
    db.prepare(
      "INSERT INTO settings (key,value,updated_at) VALUES ('compactionProfileId',?,'now')",
    ).run(JSON.stringify(p.id));
    expect(() => deleteProfile(db, p.id)).toThrow("模型");
    expect(db.prepare("SELECT id FROM model_profiles WHERE id=?").get(p.id)).toBeDefined();
  } finally {
    db.close();
  }
});
