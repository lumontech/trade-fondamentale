-- 0007_user_trade_log.sql
-- Storage server-side del TradeLog dell'utente (decisioni Claude + auto-log + outcome).
-- Permette al Review Lab di funzionare da QUALSIASI browser/device.
-- I record sono per-utente; merge client-side: il client tiene localStorage come cache
-- e sincronizza con il server ad ogni write + on session start.
--
-- Il context_snapshot può essere pesante (decine di KB JSON), quindi:
--  - JSON stringified
--  - sqlite TEXT column (no size limit ma compresso da sqlite a partire da pageSize)
-- Encryption-at-rest NON applicata qui (i trade non sono credenziali; sono dati operativi
-- dell'utente sul suo account loggato. La protezione è auth + transport TLS).

CREATE TABLE IF NOT EXISTS sim_user_trade_log (
  id              TEXT    PRIMARY KEY,             -- es: 'dec_<ts>_<random>' (stesso schema del client)
  user_id         INTEGER NOT NULL REFERENCES sim_users(id) ON DELETE CASCADE,
  opened_at       INTEGER NOT NULL,                -- unix ms
  closed_at       INTEGER,                         -- unix ms o null
  status          TEXT    NOT NULL DEFAULT 'open', -- 'open' | 'closed' | 'dismissed'
  symbol          TEXT    NOT NULL,
  timeframe       TEXT    NOT NULL,
  direction       TEXT    NOT NULL,                -- 'LONG' | 'SHORT' | 'FLAT' | 'NO_GO'
  confidence      REAL,
  entry_price     REAL,
  suggested_sl    REAL,
  suggested_tp    REAL,
  exit_price      REAL,
  pnl             REAL,
  pnl_pct         REAL,
  r_multiple      REAL,
  reasons_json    TEXT,                            -- JSON array [{type, label, detail}]
  blockers_json   TEXT,                            -- JSON array [{label}]
  context_json    TEXT,                            -- JSON context_pack snapshot (pesante)
  notes           TEXT,
  mode            TEXT,                            -- 'intraday' | 'scalping' (dal context.analysis_mode)
  updated_at      INTEGER NOT NULL                 -- unix ms (per LWW merge)
);

CREATE INDEX IF NOT EXISTS idx_trade_log_user        ON sim_user_trade_log(user_id);
CREATE INDEX IF NOT EXISTS idx_trade_log_user_status ON sim_user_trade_log(user_id, status);
CREATE INDEX IF NOT EXISTS idx_trade_log_user_symbol ON sim_user_trade_log(user_id, symbol);
CREATE INDEX IF NOT EXISTS idx_trade_log_user_opened ON sim_user_trade_log(user_id, opened_at DESC);
