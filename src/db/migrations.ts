// Bundled as text so the Worker can migrate itself on first run; the deploy button
// never needs a separate `wrangler d1 migrations apply` step.
export const MIGRATIONS: string[] = [
  /* 1: initial schema */ `
CREATE TABLE IF NOT EXISTS credentials (
  kind TEXT PRIMARY KEY,
  ciphertext TEXT NOT NULL,
  iv TEXT NOT NULL,
  meta TEXT,
  verified_at INTEGER
);
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'admin',
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS zones (
  zone_id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  account_id TEXT NOT NULL,
  plan TEXT NOT NULL,
  mode TEXT NOT NULL DEFAULT 'shadow',
  rule_ids TEXT NOT NULL DEFAULT '{}',
  shadow_since INTEGER,
  paused_until INTEGER,
  locked_until INTEGER,
  last_tick_at INTEGER,
  last_error TEXT,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS settings (
  zone_id TEXT NOT NULL DEFAULT '',
  key TEXT NOT NULL,
  value TEXT NOT NULL,
  PRIMARY KEY (zone_id, key)
);
CREATE TABLE IF NOT EXISTS allowlist (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  zone_id TEXT NOT NULL DEFAULT '',
  kind TEXT NOT NULL,
  value TEXT NOT NULL,
  note TEXT,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS spikes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  zone_id TEXT NOT NULL,
  started_at INTEGER NOT NULL,
  ended_at INTEGER,
  peak_rpm REAL NOT NULL,
  baseline_rpm REAL NOT NULL
);
CREATE INDEX IF NOT EXISTS spikes_zone ON spikes (zone_id, started_at);
CREATE TABLE IF NOT EXISTS decisions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  zone_id TEXT NOT NULL,
  spike_id INTEGER,
  cluster_key TEXT NOT NULL,
  cluster_kind TEXT NOT NULL,
  target TEXT NOT NULL,
  features TEXT NOT NULL,
  jev_answers TEXT,
  source TEXT NOT NULL,
  action TEXT NOT NULL,
  reason TEXT NOT NULL,
  applied INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS decisions_zone ON decisions (zone_id, created_at);
CREATE TABLE IF NOT EXISTS actions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  decision_id INTEGER,
  zone_id TEXT NOT NULL,
  mechanism TEXT NOT NULL,
  kind TEXT NOT NULL,
  target TEXT NOT NULL,
  applied_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  removed_at INTEGER,
  removed_by TEXT
);
CREATE INDEX IF NOT EXISTS actions_active ON actions (zone_id, removed_at, expires_at);
CREATE INDEX IF NOT EXISTS actions_target ON actions (zone_id, target, applied_at);
CREATE TABLE IF NOT EXISTS usage (
  day TEXT PRIMARY KEY,
  jev_calls INTEGER NOT NULL DEFAULT 0,
  jev_input_tokens INTEGER NOT NULL DEFAULT 0,
  est_cost REAL NOT NULL DEFAULT 0
);
`,
];
