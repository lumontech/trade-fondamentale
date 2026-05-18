-- 0006_user_api_keys.sql
-- Storage server-side delle API key dell'utente (Anthropic, TwelveData, Finnhub, ecc.)
-- così le chiavi seguono l'utente tra device diversi invece di restare in localStorage.
--
-- Encryption-at-rest: ogni record contiene encrypted+iv+tag (AES-256-GCM).
-- La chiave master è derivata da API_KEYS_SECRET (env var del server) via SHA-256.
-- Senza API_KEYS_SECRET il server rifiuta di scrivere chiavi nuove (errore esplicito).

CREATE TABLE IF NOT EXISTS sim_user_api_keys (
  user_id    INTEGER NOT NULL REFERENCES sim_users(id) ON DELETE CASCADE,
  service    TEXT    NOT NULL,           -- es: 'anthropic', 'twelvedata', 'finnhub', 'fred', 'apify', 'coingecko'
  encrypted  TEXT    NOT NULL,           -- ciphertext base64
  iv         TEXT    NOT NULL,           -- IV base64 (12 byte per GCM)
  tag        TEXT    NOT NULL,           -- auth tag base64 (16 byte per GCM)
  updated_at INTEGER NOT NULL,           -- unix seconds
  PRIMARY KEY (user_id, service)
);

CREATE INDEX IF NOT EXISTS idx_sim_user_api_keys_user ON sim_user_api_keys(user_id);
