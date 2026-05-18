// Position Sizing Dinamico — combina ATR-based SL/TP, Kelly fractional dal backtest,
// correlation-adjusted size dalle decisioni aperte.
import { getAllDecisions } from './TradeLog'

// ATR (Average True Range)
function calculateATR(candles, period = 14) {
  if (candles.length < period + 1) return null
  const trs = []
  for (let i = 1; i < candles.length; i++) {
    const c = candles[i], p = candles[i - 1]
    trs.push(Math.max(c.high - c.low, Math.abs(c.high - p.close), Math.abs(c.low - p.close)))
  }
  let atr = trs.slice(0, period).reduce((s, x) => s + x, 0) / period
  for (let i = period; i < trs.length; i++) {
    atr = (atr * (period - 1) + trs[i]) / period
  }
  return atr
}

/**
 * Kelly Criterion fractional. Ritorna la frazione del capitale "ottimale".
 * Kelly = (bp - q) / b dove b = R, p = winRate, q = 1-winRate.
 * Usiamo 1/4 Kelly (più conservativo) per evitare drawdown estremi.
 */
function fractionalKelly(winRate, avgRR) {
  if (winRate == null || avgRR == null || avgRR <= 0) return null
  const b = avgRR
  const p = winRate
  const q = 1 - p
  const kelly = (b * p - q) / b
  if (kelly <= 0) return 0
  return kelly / 4   // 1/4 Kelly
}

/**
 * Restituisce il fattore di riduzione size per correlazione con trade aperti.
 * Se ho già un trade su asset altamente correlato e nella stessa direzione,
 * la "vera" esposizione è doppia → riduco la size del nuovo.
 */
function correlationAdjustment(symbol, direction, correlationMatrix) {
  if (!correlationMatrix || !correlationMatrix[symbol]) return 1
  const open = getAllDecisions().filter(d => d.status === 'open')
  if (open.length === 0) return 1

  let totalCorrelatedExposure = 0
  for (const d of open) {
    if (d.symbol === symbol) continue
    const corr = correlationMatrix[symbol][d.symbol]
    if (corr == null) continue
    // Stessa direzione + corr positiva = somma. Direzione opposta + corr positiva = compensazione.
    const sameDir = d.direction === direction
    const effective = (sameDir ? 1 : -1) * corr
    if (effective > 0.5) totalCorrelatedExposure += effective
  }

  // Riduci size del 50% per ogni esposizione correlata significativa
  const reduction = Math.min(0.7, totalCorrelatedExposure * 0.5)
  return 1 - reduction
}

/**
 * Calcola un setup operativo dinamico con SL/TP ATR-based e size adjusted.
 *
 * @param {Object} params
 *   - symbol, direction ('LONG'|'SHORT'|null - se null usa segnale tecnico)
 *   - candles, technicalSignal, supportLevels, resistanceLevels
 *   - capital, riskPct (% per trade base)
 *   - backtestStats (per quel segnale: { winRate, avgRR, profitFactor })
 *   - correlationMatrix
 * @returns {Object} setup completo con dynamic sizing
 */
export function calculateDynamicSetup({
  symbol,
  direction = null,
  candles,
  technicalSignal,
  supportLevels = [],
  resistanceLevels = [],
  price,
  capital = 10000,
  riskPct = 1,
  backtestStats = null,
  correlationMatrix = null,
}) {
  const last = price ?? candles[candles.length - 1]?.close
  if (!last) return null

  // Determina direzione
  if (!direction && technicalSignal) {
    direction = technicalSignal.score >= 0 ? 'LONG' : 'SHORT'
  }
  if (!direction) return null
  const isLong = direction === 'LONG'

  // ── ATR-based SL/TP (più robusto rispetto a S/R puri) ───────
  const atr = calculateATR(candles, 14)
  if (!atr || atr <= 0) return null

  const slDist = atr * 1.5
  const tp1Dist = atr * 3.0
  const tp2Dist = atr * 5.0

  // SL ibrido: max tra ATR-distance e prossimo livello S/R (più conservativo)
  let sl
  if (isLong) {
    const supportSL = supportLevels[0] ?? null
    const atrSL = last - slDist
    sl = supportSL ? Math.max(supportSL - atr * 0.2, atrSL) : atrSL
  } else {
    const resSL = resistanceLevels[0] ?? null
    const atrSL = last + slDist
    sl = resSL ? Math.min(resSL + atr * 0.2, atrSL) : atrSL
  }

  const risk = Math.abs(last - sl)
  const tp1 = isLong ? last + tp1Dist : last - tp1Dist
  const tp2 = isLong ? last + tp2Dist : last - tp2Dist
  const rr1 = Math.abs(tp1 - last) / risk
  const rr2 = Math.abs(tp2 - last) / risk

  // ── Position sizing dinamico ──────────────────────────────────
  let effectiveRiskPct = riskPct
  let kellyFrac = null
  if (backtestStats && backtestStats.total >= 10) {
    kellyFrac = fractionalKelly(backtestStats.winRate, Math.max(0.5, backtestStats.avgRR + 1))
    if (kellyFrac != null) {
      // Kelly suggerisce X% del capitale. Limita a max riskPct configurato.
      const kellyPct = kellyFrac * 100
      effectiveRiskPct = Math.min(riskPct, kellyPct)
      // Se Kelly è negativo (edge negativo), riduci a 0.25% minimo
      if (kellyPct <= 0) effectiveRiskPct = Math.min(0.25, riskPct)
    }
  }

  const corrAdj = correlationAdjustment(symbol, direction, correlationMatrix)
  const finalRiskPct = effectiveRiskPct * corrAdj

  const riskAmount = capital * (finalRiskPct / 100)
  const units = riskAmount / risk

  return {
    direction,
    entry: last,
    sl,
    tp1,
    tp2,
    risk,
    rr1,
    rr2,
    atr,
    pctSL:  ((sl - last) / last * 100),
    pctTP1: ((tp1 - last) / last * 100),
    pctTP2: ((tp2 - last) / last * 100),
    sizing: {
      base_risk_pct:     riskPct,
      effective_risk_pct: finalRiskPct,
      kelly_fraction:    kellyFrac,
      correlation_adj:   corrAdj,
      risk_amount:       riskAmount,
      units,
    },
    backtest_winrate: backtestStats?.winRate ?? null,
  }
}
