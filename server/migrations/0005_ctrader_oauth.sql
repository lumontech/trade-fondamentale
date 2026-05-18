-- Migration 0005: cTrader Open API OAuth token storage
-- Salva access_token + refresh_token + scope per il flow OAuth2.
-- 1 sola riga (single-user): l'utente autorizza una sola volta, il backend
-- rinnova automaticamente access_token via refresh_token (validità 30gg).

CREATE TABLE IF NOT EXISTS ctrader_tokens (
  id              INTEGER PRIMARY KEY,
  access_token    TEXT NOT NULL,
  refresh_token   TEXT NOT NULL,
  token_type      TEXT NOT NULL DEFAULT 'bearer',
  scope           TEXT NOT NULL,           -- 'accounts' | 'accounts trading'
  expires_at      INTEGER NOT NULL,        -- unix seconds, quando access_token scade
  refresh_expires_at INTEGER,              -- unix seconds, quando refresh_token scade
  account_id      INTEGER,                 -- ctidTraderAccountId scelto dall'utente
  account_label   TEXT,                    -- es. "FPMarkets Demo €1000"
  is_live         INTEGER DEFAULT 0,       -- 0=demo, 1=live
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL,
  CHECK (id = 1)
);

-- Tabella simboli cTrader cached (1 sola fetch poi cache locale)
-- symbolId è id integer assegnato da cTrader, diverso per ogni broker
CREATE TABLE IF NOT EXISTS ctrader_symbols (
  symbol_id     INTEGER PRIMARY KEY,
  symbol_name   TEXT NOT NULL,             -- es. 'EURUSD', 'XAUUSD', 'BTCUSD'
  digits        INTEGER NOT NULL,          -- es. 5 per EURUSD, 2 per XAU
  pip_position  INTEGER NOT NULL,          -- es. 4 (pip = 10^-pipPosition)
  enabled       INTEGER DEFAULT 1,
  account_id    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ctrader_symbols_name ON ctrader_symbols(symbol_name);
