-- Migration 0002: Multi-profile support
-- Aggiunge profile_id a tutte le tabelle. Profilo 1 = default (account principale).
-- Profilo 2+ = sub-account separati (es. BTC Scalp Lab con balance maggiore).

-- ── Drop CHECK constraint su sim_config (era id=1) ────────────────
-- SQLite non supporta ALTER TABLE DROP CONSTRAINT. Usiamo ricostruzione.
CREATE TABLE IF NOT EXISTS sim_config_v2 (
  id              INTEGER PRIMARY KEY,
  label           TEXT NOT NULL DEFAULT 'Default',
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
  broker_id       TEXT NOT NULL DEFAULT 'fpmarkets_standard',
  cycles          INTEGER NOT NULL DEFAULT 0,
  last_tick_at    INTEGER,
  updated_at      INTEGER NOT NULL
);

-- Migrate existing config (id=1) into v2
INSERT OR IGNORE INTO sim_config_v2 (id, label, active, started_at, stopped_at, pairs,
  swing_strategies, scalp_strategies, swing_tf, scalp_tf, starting_balance, risk_pct,
  compounding, broker_id, cycles, last_tick_at, updated_at)
SELECT id, 'Main FPMarkets EU', active, started_at, stopped_at, pairs,
  swing_strategies, scalp_strategies, swing_tf, scalp_tf, starting_balance, risk_pct,
  compounding, broker_id, cycles, last_tick_at, updated_at
FROM sim_config WHERE id = 1;

DROP TABLE sim_config;
ALTER TABLE sim_config_v2 RENAME TO sim_config;

-- ── Add profile_id to sim_accounts ─────────────────────────────────
ALTER TABLE sim_accounts ADD COLUMN profile_id INTEGER NOT NULL DEFAULT 1;
CREATE INDEX IF NOT EXISTS idx_sim_accounts_profile ON sim_accounts (profile_id);

-- account_key resta unique globalmente (= profile + strategy + pair + tf)
-- Convenzione applicativa: account_key per profile 1 e' "{strat}_{pair}_{tf}"
-- per profile 2+ e' "p{N}_{strat}_{pair}_{tf}"

-- ── Add profile_id ai trades + equity + errors per facili join ────
ALTER TABLE sim_trades ADD COLUMN profile_id INTEGER NOT NULL DEFAULT 1;
CREATE INDEX IF NOT EXISTS idx_sim_trades_profile ON sim_trades (profile_id);

ALTER TABLE sim_equity ADD COLUMN profile_id INTEGER NOT NULL DEFAULT 1;
ALTER TABLE sim_errors ADD COLUMN profile_id INTEGER;
