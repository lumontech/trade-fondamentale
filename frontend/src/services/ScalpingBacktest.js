// ScalpingBacktest — runner di backtest per strategie scalp.
// Differenze rispetto a StrategyLibrary backtest:
// - SL/TP da metadata della strategia (non globali)
// - maxBars MOLTO più stretto (scalp tiene poche barre)
// - Costo per trade in R molto più impattante
// - Metriche specifiche: trades/giorno, avg holding time, costo % della WR
import { getCostInR } from './TradingCosts'
import { significanceLevel, winRateConfidenceInterval, walkForwardSplit, calculateRiskMetrics } from './BacktestStatistics'

function atrLocal(candles, period, i) {
  if (i < period) return null
  let s = 0
  for (let j = i - period + 1; j <= i; j++) {
    const c = candles[j], p = candles[j - 1]
    s += Math.max(c.high - c.low, Math.abs(c.high - p.close), Math.abs(c.low - p.close))
  }
  return s / period
}

function simulateScalpTrade(candles, i, direction, slMul, tpMul, maxBars, symbol, brokerId) {
  const a = atrLocal(candles, 14, i)
  if (!a || a === 0) return null
  const entry = candles[i].close
  const slDist = a * slMul
  const tpDist = a * tpMul
  const sl = direction === 'long' ? entry - slDist : entry + slDist
  const tp = direction === 'long' ? entry + tpDist : entry - tpDist

  const costInR = getCostInR(symbol, a, slDist, brokerId)

  for (let j = i + 1; j <= i + maxBars && j < candles.length; j++) {
    const bar = candles[j]
    if (direction === 'long') {
      if (bar.low  <= sl) return { outcome: 'sl', rr: -1 - costInR, rawRR: -1, costInR, bars: j - i }
      if (bar.high >= tp) return { outcome: 'tp', rr: (tpMul / slMul) - costInR, rawRR: tpMul / slMul, costInR, bars: j - i }
    } else {
      if (bar.high >= sl) return { outcome: 'sl', rr: -1 - costInR, rawRR: -1, costInR, bars: j - i }
      if (bar.low  <= tp) return { outcome: 'tp', rr: (tpMul / slMul) - costInR, rawRR: tpMul / slMul, costInR, bars: j - i }
    }
  }
  // Timeout: chiudi al close
  const j = Math.min(i + maxBars, candles.length - 1)
  const exit = candles[j].close
  const pnl = direction === 'long' ? exit - entry : entry - exit
  const rawRR = pnl / slDist
  return { outcome: 'timeout', rr: rawRR - costInR, rawRR, costInR, bars: j - i }
}

/**
 * Backtest di una strategia scalp su un asset.
 */
export function runScalpBacktest(strategy, candles, opts = {}) {
  const cfg = {
    minWarmup:    100,
    maxBars:      12,                    // scalp tiene massimo 12 bar (60min su 5m, 3h su 15m)
    symbol:       null,
    brokerId:     'fpmarkets_raw',
    walkForward:  true,
    ...opts,
  }
  if (!candles || candles.length < cfg.minWarmup + cfg.maxBars + 10) {
    return { error: 'Candele insufficienti', trades: [], summary: null }
  }
  const slMul = strategy.slMul || 0.8
  const tpMul = strategy.tpMul || 1.5

  const trades = []
  for (let i = cfg.minWarmup; i < candles.length - cfg.maxBars; i++) {
    const sig = strategy.fn(candles, i)
    if (!sig || !sig.direction) continue
    const trade = simulateScalpTrade(candles, i, sig.direction, slMul, tpMul, cfg.maxBars, cfg.symbol, cfg.brokerId)
    if (!trade) continue
    trades.push({
      time: candles[i].time, bar: i,
      direction: sig.direction, reason: sig.reason,
      ...trade,
    })
  }

  if (trades.length === 0) {
    return { trades, summary: { strategyId: strategy.id, total: 0, error: 'Nessun trade rilevato' } }
  }

  // Aggregati
  const total   = trades.length
  const wins    = trades.filter(t => t.outcome === 'tp').length
  const losses  = trades.filter(t => t.outcome === 'sl').length
  const closed  = wins + losses
  const winRate = closed > 0 ? wins / closed : 0
  const avgRR    = trades.reduce((s, t) => s + t.rr, 0) / total
  const avgRawRR = trades.reduce((s, t) => s + (t.rawRR || t.rr), 0) / total
  const avgCost  = trades.reduce((s, t) => s + (t.costInR || 0), 0) / total
  const avgHold  = trades.reduce((s, t) => s + t.bars, 0) / total
  const grossWin  = trades.filter(t => t.rr > 0).reduce((s, t) => s + t.rr, 0)
  const grossLoss = Math.abs(trades.filter(t => t.rr < 0).reduce((s, t) => s + t.rr, 0))
  const profitFactor = grossLoss > 0 ? grossWin / grossLoss : (grossWin > 0 ? Infinity : 0)

  // Trades/day basato su tempo coperto
  const totalSeconds = candles[candles.length - 1].time - candles[cfg.minWarmup].time
  const totalDays    = Math.max(1, totalSeconds / 86400)
  const tradesPerDay = total / totalDays

  // Equity
  let eq = 0, peak = 0, maxDD = 0
  for (const t of trades) {
    eq += t.rr
    if (eq > peak) peak = eq
    if (peak - eq > maxDD) maxDD = peak - eq
  }

  // Costo come % della WR teorica
  // Se WR_no_costs = 60% e WR_real = 55%, costi mangiano 5pp di WR
  // Calcoliamo: WR teorica con rr=rawRR vs rr=rr
  const winsRaw = trades.filter(t => (t.rawRR || t.rr) > 0).length
  const winRateRaw = total > 0 ? winsRaw / total : 0
  const wrLossFromCosts = winRateRaw - winRate

  const significance = significanceLevel(total)
  const ci = winRateConfidenceInterval(wins, closed)
  const wf = cfg.walkForward && trades.length >= 30 ? walkForwardSplit(trades, 0.7) : null
  const risk = calculateRiskMetrics(trades.map(t => t.rr))

  return {
    trades,
    summary: {
      strategyId: strategy.id,
      strategyName: strategy.name,
      total, wins, losses,
      timeouts: total - closed,
      winRate, winRateRaw, wrLossFromCosts,
      avgRR, avgRawRR, avgCost,
      avgHold, tradesPerDay,
      profitFactor, maxDD,
      finalEquity: eq,
      significance, confidenceInterval: ci,
      walkForward: wf,
      sharpe: risk.sharpe, sortino: risk.sortino,
    },
  }
}

/**
 * Esegue una strategia su tutti gli asset compatibili e ritorna grid risultati.
 * @param {Object} strategy
 * @param {Object} candlesByPair - { XAUUSD: [...], BTCUSD: [...], ... }
 * @param {Object} opts - { brokerId }
 */
export function runScalpStrategyAcrossPairs(strategy, candlesByPair, opts = {}) {
  const out = {}
  for (const [pair, candles] of Object.entries(candlesByPair)) {
    if (!candles || candles.length === 0) continue
    out[pair] = runScalpBacktest(strategy, candles, { ...opts, symbol: pair })
  }
  return out
}
