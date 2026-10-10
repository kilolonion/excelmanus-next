import { SandboxPool } from "../../src/index.ts";
const pool = new SandboxPool({ size: 1 });
try {
  const failure = await pool.run({ code: "return JSON.parse('['.repeat(2e6) + ']'.repeat(2e6)).length", timeoutMs: 5000, namespaces: {} }, { call: async () => null });
  const next = await pool.run({ code: "return 42", timeoutMs: 2000, namespaces: {} }, { call: async () => null });
  process.stdout.write(JSON.stringify({ failure: failure.kind, next }));
} finally { await pool.close(); }
