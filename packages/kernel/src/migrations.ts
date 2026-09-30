// 内核基础迁移（10 §3）。每个数组元素 = 一个迁移版本，整体在 openDb 的单事务中执行。
// 模块迁移由 server 拼接在本数组之后。

export const KERNEL_MIGRATIONS: readonly string[] = [
  `
  CREATE TABLE session_log (
    session_id TEXT NOT NULL,
    seq INTEGER NOT NULL,
    agent_id TEXT,
    type TEXT NOT NULL,
    data TEXT NOT NULL CHECK (json_valid(data)),
    created_at TEXT NOT NULL,
    PRIMARY KEY (session_id, seq)
  ) WITHOUT ROWID;

  CREATE TABLE sessions (
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL DEFAULT '',
    title TEXT,
    permission_mode TEXT NOT NULL DEFAULT 'standard',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    last_seq INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE agents (
    id TEXT NOT NULL,
    session_id TEXT NOT NULL,
    parent_id TEXT,
    name TEXT,
    role TEXT NOT NULL DEFAULT 'main',
    status TEXT NOT NULL DEFAULT 'idle',
    model_profile_id TEXT,
    system_prompt TEXT,
    budget TEXT,
    usage TEXT,
    closed_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (session_id, id)
  ) WITHOUT ROWID;

  CREATE TABLE agent_context (
    agent_id TEXT NOT NULL,
    session_id TEXT NOT NULL,
    idx INTEGER NOT NULL,
    item TEXT NOT NULL CHECK (json_valid(item)),
    from_seq INTEGER NOT NULL,
    superseded INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (session_id, agent_id, idx)
  ) WITHOUT ROWID;

  CREATE TABLE dispatches (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    agent_id TEXT NOT NULL,
    client_message_id TEXT NOT NULL,
    mode TEXT NOT NULL DEFAULT 'queue',
    status TEXT NOT NULL DEFAULT 'accepted',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE (session_id, agent_id, client_message_id)
  );

  CREATE TABLE open_intents (
    agent_id TEXT NOT NULL,
    session_id TEXT NOT NULL,
    tool_call_id TEXT NOT NULL,
    step_id TEXT NOT NULL,
    tool_name TEXT NOT NULL,
    targets TEXT NOT NULL DEFAULT '[]',
    replay TEXT NOT NULL DEFAULT 'unknown',
    created_seq INTEGER NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY (session_id, agent_id, tool_call_id)
  ) WITHOUT ROWID;
  CREATE INDEX open_intents_session ON open_intents(session_id);

  CREATE TABLE devices (
    id TEXT PRIMARY KEY,
    name TEXT,
    kind TEXT NOT NULL DEFAULT 'local',
    token_hash TEXT NOT NULL UNIQUE,
    created_at TEXT NOT NULL,
    last_seen_at TEXT,
    revoked_at TEXT
  );

  CREATE TABLE workspaces (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    path TEXT NOT NULL UNIQUE,
    is_default INTEGER NOT NULL DEFAULT 0,
    sort INTEGER NOT NULL DEFAULT 0,
    last_opened_at TEXT,
    created_at TEXT NOT NULL
  );

  CREATE TABLE credentials (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL DEFAULT 'api_key',
    provider TEXT NOT NULL,
    ciphertext BLOB NOT NULL,
    nonce BLOB NOT NULL,
    meta TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(meta)),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE model_profiles (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    provider TEXT NOT NULL,
    model TEXT NOT NULL,
    base_url TEXT,
    credential_id TEXT REFERENCES credentials(id),
    context_window INTEGER,
    max_output_tokens INTEGER,
    reasoning TEXT,
    provider_options TEXT CHECK (provider_options IS NULL OR json_valid(provider_options)),
    is_default INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL CHECK (json_valid(value)),
    updated_at TEXT NOT NULL
  );
  `,
];
