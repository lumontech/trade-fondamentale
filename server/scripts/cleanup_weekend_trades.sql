-- Cleanup trade aperti durante mercato chiuso (forex/XAU nel weekend)
-- Esegui prima un SELECT per vedere quanti record verranno eliminati,
-- poi DELETE.
--
-- Convenzione: entry_time e' UNIX seconds UTC.
-- strftime('%w', ...) ritorna 0=Dom 1=Lun ... 6=Sab
-- Forex/XAU mercato CHIUSO: Sabato (6) tutto il giorno + Dom (0) prima delle 22 + Ven dopo le 22

-- ── Conta i trade weekend per asset ────────────────────────────────
SELECT
  CASE strftime('%w', datetime(entry_time, 'unixepoch'))
    WHEN '0' THEN 'Dom'
    WHEN '6' THEN 'Sab'
  END AS dow,
  substr(account_key, 1, 30) AS account,
  COUNT(*) AS n
FROM sim_trades
WHERE strftime('%w', datetime(entry_time, 'unixepoch')) IN ('0', '6')
  AND account_key NOT LIKE '%BTCUSD%'
  AND account_key NOT LIKE '%ETHUSD%'
GROUP BY dow, account
ORDER BY n DESC;

-- ── DELETE: tradi creati con mercato chiuso ────────────────────────
-- DECOMMENTA per applicare:
--
-- DELETE FROM sim_trades
-- WHERE strftime('%w', datetime(entry_time, 'unixepoch')) IN ('0', '6')
--   AND account_key NOT LIKE '%BTCUSD%'
--   AND account_key NOT LIKE '%ETHUSD%';
--
-- Inoltre: delete trade Forex venerdi >=22:00 UTC e Dom <22:00 UTC
-- DELETE FROM sim_trades
-- WHERE (
--   (strftime('%w', datetime(entry_time, 'unixepoch')) = '5' AND
--    CAST(strftime('%H', datetime(entry_time, 'unixepoch')) AS INTEGER) >= 22)
--   OR
--   (strftime('%w', datetime(entry_time, 'unixepoch')) = '0' AND
--    CAST(strftime('%H', datetime(entry_time, 'unixepoch')) AS INTEGER) < 22)
-- )
-- AND account_key NOT LIKE '%BTCUSD%'
-- AND account_key NOT LIKE '%ETHUSD%';
