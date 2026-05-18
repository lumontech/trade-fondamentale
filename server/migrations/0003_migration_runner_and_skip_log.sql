-- 0003 Migration runner + skip log + perf indexes
CREATE TABLE IF NOT EXISTS _migrations (
  name TEXT PRIMARY KEY,
  applied_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS sim_skip_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  account_key TEXT NOT NULL,
  reason TEXT NOT NULL,
  symbol TEXT,
  tf TEXT
);
CREATE INDEX IF NOT EXISTS idx_skip_log_account ON sim_skip_log(account_key, ts);
CREATE INDEX IF NOT EXISTS idx_sim_config_active ON sim_config(active) WHERE active = 1;
CREATE INDEX IF NOT EXISTS idx_sim_trades_account_id ON sim_trades(account_key, id DESC);
