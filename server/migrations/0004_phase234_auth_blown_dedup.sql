-- Migration 0004: Phase 2+3 schema (auth backend + blown handling + equity dedup)
-- Atomic, additive, idempotent.
--
-- NOTA: SQLite ALTER TABLE ADD COLUMN non supporta IF NOT EXISTS, ma il migration
-- runner di Phase 1 (server/src/db.js) gestisce l'idempotenza tramite la tabella
-- _migrations -> ogni file viene applicato al massimo UNA volta. Safe.
--
-- Sezioni:
--   1. Phase 3.1 — Auth backend (sim_users + sim_sessions)
--   2. Phase 2.1 — Blown account handling (paused_reason, paused_at su sim_config)
--   3. Phase 2.8 — Equity dedup heartbeat (last_equity_write su sim_accounts)

-- =====================================================================
-- 1. Phase 3.1 — Auth backend
-- =====================================================================
CREATE TABLE IF NOT EXISTS sim_users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  username      TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  role          TEXT NOT NULL DEFAULT 'admin',
  created_at    INTEGER NOT NULL,
  last_login_at INTEGER
);

CREATE TABLE IF NOT EXISTS sim_sessions (
  id         TEXT PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES sim_users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  ip         TEXT,
  user_agent TEXT
);

CREATE INDEX IF NOT EXISTS idx_sim_sessions_expires ON sim_sessions(expires_at);
CREATE INDEX IF NOT EXISTS idx_sim_sessions_user    ON sim_sessions(user_id);

-- =====================================================================
-- 2. Phase 2.1 — Blown account handling
-- =====================================================================
-- Quando >50% account di un profilo sono blown -> auto-pause profilo
-- e tracciamo il motivo + timestamp per audit / dashboard.
ALTER TABLE sim_config ADD COLUMN paused_reason TEXT;
ALTER TABLE sim_config ADD COLUMN paused_at     INTEGER;

-- =====================================================================
-- 3. Phase 2.8 — Equity dedup heartbeat
-- =====================================================================
-- Evita di scrivere equity points duplicati ad ogni tick: scriviamo
-- solo se il bilancio e' cambiato OPPURE se sono passati >5 min dall'ultimo
-- write (heartbeat). last_equity_write e' il timestamp dell'ultima scrittura.
ALTER TABLE sim_accounts ADD COLUMN last_equity_write INTEGER DEFAULT 0;
