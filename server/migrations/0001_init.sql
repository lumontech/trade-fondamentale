-- Impact Trading Server · SQLite schema v0.1

CREATE TABLE IF NOT EXISTS sim_config (
  id              INTEGER PRIMARY KEY CHECK (id = 1),
  active          INTEGER NOT NULL DEFAULT 0,
  started_at      INTEGER,
  stopped_at      INTEGER,
  pairs           TEXT NOT NULL,
  swing_strategies TEXT NOT NULL,
  scalp_strategies TEXT NOT NULL,
  swing_tf        TEXT NOT NULL DEFAULT '4h',
  scalp_tf        TEXT NOT NULL DEFAULT '15m',
  starting_balance REAL NOT NULL DEFAULT 1000,
  risk_pct        REAL NOT NULL DEFAULT 1,
  compounding     INTEGER NOT NULL DEFAULT 1,
  broker_id       TEXT NOT NULL DEFAULT 'fpmarkets_raw',
  cycles          INTEGER NOT NULL DEFAULT 0,
  last_tick_at    INTEGER,
  updated_at      INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS sim_accounts (
  account_key     TEXT PRIMARY KEY,
  strategy_id     TEXT NOT NULL,
  strategy_name   TEXT NOT NULL,
  category        TEXT NOT NULL,
  symbol          TEXT NOT NULL,
  timeframe       TEXT NOT NULL,
  sl_mul          REAL NOT NULL,
  tp_mul          REAL NOT NULL,
  starting_balance REAL NOT NULL,
  balance         REAL NOT NULL,
  peak_balance    REAL NOT NULL,
  open_position   TEXT,
  last_bar_time   INTEGER,
  blown           INTEGER NOT NULL DEFAULT 0,
  blown_at        INTEGER,
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_sim_accounts_symbol ON sim_accounts (symbol, timeframe);
CREATE INDEX IF NOT EXISTS idx_sim_accounts_category ON sim_accounts (category);

CREATE TABLE IF NOT EXISTS sim_trades (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  account_key     TEXT NOT NULL REFERENCES sim_accounts(account_key) ON DELETE CASCADE,
  entry_time      INTEGER NOT NULL,
  exit_time       INTEGER NOT NULL,
  direction       TEXT NOT NULL,
  entry           REAL NOT NULL,
  sl              REAL NOT NULL,
  tp              REAL NOT NULL,
  exit_price      REAL NOT NULL,
  outcome         TEXT NOT NULL,
  raw_rr          REAL NOT NULL,
  cost_in_r       REAL NOT NULL,
  net_rr          REAL NOT NULL,
  pnl_eur         REAL NOT NULL,
  balance_after   REAL NOT NULL,
  reason          TEXT,
  created_at      INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_sim_trades_account ON sim_trades (account_key, entry_time);
CREATE INDEX IF NOT EXISTS idx_sim_trades_outcome ON sim_trades (outcome);

CREATE TABLE IF NOT EXISTS sim_equity (
  account_key     TEXT NOT NULL REFERENCES sim_accounts(account_key) ON DELETE CASCADE,
  ts              INTEGER NOT NULL,
  balance         REAL NOT NULL,
  PRIMARY KEY (account_key, ts)
);

CREATE TABLE IF NOT EXISTS sim_errors (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  ts              INTEGER NOT NULL,
  scope           TEXT,
  symbol          TEXT,
  message         TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_sim_errors_ts ON sim_errors (ts DESC);

CREATE TABLE IF NOT EXISTS candle_cache (
  symbol          TEXT NOT NULL,
  timeframe       TEXT NOT NULL,
  fetched_at      INTEGER NOT NULL,
  candles_json    TEXT NOT NULL,
  PRIMARY KEY (symbol, timeframe)
);
