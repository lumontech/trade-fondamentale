// Adaptive SL/TP — ricalcola sl_mul/tp_mul ogni 20 trade chiusi per account_key
// in base al win rate storico. Heuristic semplice (no ML) ma stabile:
//   WR < 35% → strategia che perde: allarga SL (-stop hunt), stringe TP
//   WR > 55% → strategia vincente:   stringe SL (proteggi), allarga TP
//   altrimenti → no change
//
// Fix #4.2 — DEFAULT OFF. Abilitare con env ADAPTIVE_SLTP_ENABLED=true.
// Persistenza: UPDATE diretto su sim_accounts.sl_mul / tp_mul (colonne gia
// in 0001_init.sql, no schema change). Bounded clamp [0.5, 5.0] evita drift.

const WINDOW_TRADES = 20
const SL_MIN = 0.5
const SL_MAX = 3.0
const TP_MIN = 0.5
const TP_MAX = 5.0

export function isAdaptiveEnabled() {
  return process.env.ADAPTIVE_SLTP_ENABLED === 'true'
}

/**
 * Calcola adjustment per (slDelta, tpDelta) basato sul WR ultimi 20 trade.
 * Triggera SOLO ad ogni multiplo esatto di WINDOW_TRADES (no recompute ogni trade).
 * @returns {Object|null} { slDelta, tpDelta, winRate, sampleSize } o null
 */
export async function recomputeMultipliers(db, accountKey) {
  if (!isAdaptiveEnabled()) return null

  // Trade chiusi totali su questo account
  const countRow = await db.prepare(
    'SELECT COUNT(*) AS n FROM sim_trades WHERE account_key = ?'
  ).bind(accountKey).first()
  const n = countRow?.n || 0
  if (n < WINDOW_TRADES) return null
  if (n % WINDOW_TRADES !== 0) return null  // solo a multipli esatti di 20

  // Ultimi WINDOW_TRADES trade
  const { results } = await db.prepare(
    'SELECT raw_rr, outcome FROM sim_trades WHERE account_key = ? ORDER BY id DESC LIMIT ?'
  ).bind(accountKey, WINDOW_TRADES).all()

  if (!results || results.length < WINDOW_TRADES) return null

  const wins = results.filter(t => t.raw_rr > 0).length
  const winRate = wins / results.length

  let slDelta = 0, tpDelta = 0
  if (winRate < 0.35) {
    // Loss-heavy: allarga SL per non essere stoppato dalle wick, stringe TP
    slDelta = +0.2
    tpDelta = -0.2
  } else if (winRate > 0.55) {
    // Win-heavy: stringi SL (proteggi profitti), allarga TP per let winners run
    slDelta = -0.1
    tpDelta = +0.3
  } else {
    return null  // WR normale, no change
  }

  return { slDelta, tpDelta, winRate, sampleSize: results.length }
}

/**
 * Applica adjustment all'account in-memory. Ritorna true se sl_mul/tp_mul sono
 * effettivamente cambiati (clamp puo annullare il delta).
 */
export function applyMultiplierAdjustment(acc, adj) {
  if (!adj) return false
  const newSlMul = Math.max(SL_MIN, Math.min(SL_MAX, acc.sl_mul + adj.slDelta))
  const newTpMul = Math.max(TP_MIN, Math.min(TP_MAX, acc.tp_mul + adj.tpDelta))
  if (newSlMul === acc.sl_mul && newTpMul === acc.tp_mul) return false
  acc.sl_mul = newSlMul
  acc.tp_mul = newTpMul
  return true
}

/**
 * Helper end-to-end: recompute + apply + persist. Chiamato da sim.js dopo che
 * un account ha chiuso almeno un trade in questo tick. Catch interno = no-op
 * silente sui DB error per non bloccare il main tick loop.
 */
export async function maybeAdapt(db, acc) {
  try {
    const adj = await recomputeMultipliers(db, acc.account_key)
    if (adj && applyMultiplierAdjustment(acc, adj)) {
      console.log(`[adaptive] ${acc.account_key} WR=${(adj.winRate * 100).toFixed(1)}% sl_mul=${acc.sl_mul.toFixed(2)} tp_mul=${acc.tp_mul.toFixed(2)}`)
      await db.prepare(
        'UPDATE sim_accounts SET sl_mul = ?, tp_mul = ?, updated_at = ? WHERE account_key = ?'
      ).bind(acc.sl_mul, acc.tp_mul, Math.floor(Date.now() / 1000), acc.account_key).run()
    }
  } catch (err) {
    console.warn(`[adaptive] ${acc.account_key} error:`, err.message)
  }
}
