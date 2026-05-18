-- Impact Trading Worker · Schema D1 v0.1
-- Run: wrangler d1 execute impact_trading --remote --file=./migrations/0001_init.sql

-- ── Configurazione globale ─────────────────────────────────────────
-- Solo 1 row, id=1
CREATE TABLE IF NOT EXISTS sim_config (
  id              INTEGER PRIMARY KEY CHECK (id = 1),
  active          INTEGER NOT NULL DEFAULT 0,         -- bool 0/1
  started_at      INTEGER,                            -- unix seconds
  stopped_at      INTEGER,
  pairs           TEXT NOT NULL,                      -- JSON array
  swing_strategies TEXT NOT NULL,                     -- JSON array di strategy ids
  scalp_strategies TEXT NOT NULL,                     -- JSON array
  swing_tf        TEXT NOT NULL DEFAULT '4h',
  scalp_tf        TEXT NOT NULL DEFAULT '15m',
  starting_balance REAL NOT NULL DEFAULT 1000,
  risk_pct        REAL NOT NULL DEFAULT 1,
  compounding     INTEGER NOT NULL DEFAULT 1,
  broker_id       TEXT NOT NULL DEFAULT 'fpmarkets_raw',
  cycles          INTEGER NOT NULL DEFAULT 0,
  last_tick_at    INTEGER,
  updated_at      INTEGER NOT NULL DEFAULT (unixepoch())
);

-- ── Account paper trading ──────────────────────────────────────────
-- Ogni (strategy_id, symbol, timeframe) = 1 row
CREATE TABLE IF NOT EXISTS sim_accounts (
  account_key     TEXT PRIMARY KEY,                   -- "{stratId}_{pair}_{tf}"
  strategy_id     TEXT NOT NULL,
  strategy_name   TEXT NOT NULL,
  category        TEXT NOT NULL,                      -- 'swing' | 'scalp'
  symbol          TEXT NOT NULL,
  timeframe       TEXT NOT NULL,
  sl_mul          REAL NOT NULL,
  tp_mul          REAL NOT NULL,
  starting_balance REAL NOT NULL,
  balance         REAL NOT NULL,                      -- realizzato
  peak_balance    REAL NOT NULL,
  open_position   TEXT,                               -- JSON {direction, entry, sl, tp, ...} o NULL
  last_bar_time   INTEGER,                            -- unix seconds dell'ultimo bar processato
  blown           INTEGER NOT NULL DEFAULT 0,
  blown_at        INTEGER,
  created_at      INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at      INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE INDEX IF NOT EXISTS idx_sim_accounts_symbol ON sim_accounts (symbol, timeframe);
CREATE INDEX IF NOT EXISTS idx_sim_accounts_category ON sim_accounts (category);
CREATE INDEX IF NOT EXISTS idx_sim_accounts_open ON sim_accounts (open_position);

-- ── Trade chiusi ───────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS sim_trades (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  account_key     TEXT NOT NULL REFERENCES sim_accounts(account_key) ON DELETE CASCADE,
  entry_time      INTEGER NOT NULL,
  exit_time       INTEGER NOT NULL,
  direction       TEXT NOT NULL,                      -- 'long' | 'short'
  entry           REAL NOT NULL,
  sl              REAL NOT NULL,
  tp              REAL NOT NULL,
  exit_price      REAL NOT NULL,
  outcome         TEXT NOT NULL,                      -- 'tp' | 'sl' | 'timeout'
  raw_rr          REAL NOT NULL,
  cost_in_r       REAL NOT NULL,
  net_rr          REAL NOT NULL,
  pnl_eur         REAL NOT NULL,
  balance_after   REAL NOT NULL,
  reason          TEXT,
  created_at      INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE INDEX IF NOT EXISTS idx_sim_trades_account ON sim_trades (account_key, entry_time);
CREATE INDEX IF NOT EXISTS idx_sim_trades_outcome ON sim_trades (outcome);

-- ── Equity curve (downsampled) ─────────────────────────────────────
-- Salviamo 1 punto per ogni nuovo bar processato per quell'account
CREATE TABLE IF NOT EXISTS sim_equity (
  account_key     TEXT NOT NULL REFERENCES sim_accounts(account_key) ON DELETE CASCADE,
  ts              INTEGER NOT NULL,                   -- unix seconds del bar
  balance         REAL NOT NULL,
  PRIMARY KEY (account_key, ts)
);

-- ── Errori / log diagnostici (last 100) ────────────────────────────
CREATE TABLE IF NOT EXISTS sim_errors (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  ts              INTEGER NOT NULL DEFAULT (unixepoch()),
  scope           TEXT,                               -- 'tick' | 'data' | 'strategy' | ...
  symbol          TEXT,
  message         TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_sim_errors_ts ON sim_errors (ts DESC);

-- ── Cache candele (per ridurre chiamate API tra cron tick) ─────────
-- Le candele vengono cached per pair+tf con TTL gestito a livello applicativo
CREATE TABLE IF NOT EXISTS candle_cache (
  symbol          TEXT NOT NULL,
  timeframe       TEXT NOT NULL,
  fetched_at      INTEGER NOT NULL,
  candles_json    TEXT NOT NULL,                      -- JSON array delle candele
  PRIMARY KEY (symbol, timeframe)
);
