// Simulator — paper trading simulation in EUR per ogni (strategia × asset).
// Modello: ogni trade rischia 1% del balance corrente (compounding), R-multiple convertito in EUR.
// Track: balance, equity curve, max drawdown, trade list, blown account (-50%).
import { getCostInR } from './TradingCosts'
import { significanceLevel, walkForwardSplit } from './BacktestStatistics'

// ── ATR helper ─────────────────────────────────────────────────────
function atrAt(candles, period, i) {
  if (i < period) return null
  let s = 0
  for (let j = i - period + 1; j <= i; j++) {
    const c = candles[j], p = candles[j - 1]
    s += Math.max(c.high - c.low, Math.abs(c.high - p.close), Math.abs(c.low - p.close))
  }
  return s / period
}

// ── Trade simulator (riusa logica) ─────────────────────────────────
function simulateTrade(candles, i, direction, slMul, tpMul, maxBars, symbol, brokerId) {
  const a = atrAt(candles, 14, i)
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
      if (bar.low  <= sl) return { outcome: 'sl', rr: -1 - costInR, rawRR: -1, costInR, bars: j - i, exitTime: bar.time }
      if (bar.high >= tp) return { outcome: 'tp', rr: (tpMul / slMul) - costInR, rawRR: tpMul / slMul, costInR, bars: j - i, exitTime: bar.time }
    } else {
      if (bar.high >= sl) return { outcome: 'sl', rr: -1 - costInR, rawRR: -1, costInR, bars: j - i, exitTime: bar.time }
      if (bar.low  <= tp) return { outcome: 'tp', rr: (tpMul / slMul) - costInR, rawRR: tpMul / slMul, costInR, bars: j - i, exitTime: bar.time }
    }
  }
  const j = Math.min(i + maxBars, candles.length - 1)
  const exit = candles[j].close
  const pnl = direction === 'long' ? exit - entry : entry - exit
  const rawRR = pnl / slDist
  return { outcome: 'timeout', rr: rawRR - costInR, rawRR, costInR, bars: j - i, exitTime: candles[j].time }
}

// ── Main simulator ─────────────────────────────────────────────────
/**
 * Simula un account paper trading con €X di balance iniziale per una strategia su un asset.
 * @param {Object} strategy - oggetto strategia { id, name, slMul?, tpMul?, fn }
 * @param {Array}  candles  - array candele storiche
 * @param {Object} opts     - { startingBalance, riskPerTrade, symbol, brokerId, slMul, tpMul, maxBars, minWarmup, ruinThreshold }
 */
export function simulateAccount(strategy, candles, opts = {}) {
  const cfg = {
    startingBalance: 1000,         // EUR
    riskPerTrade:    0.01,         // 1% del balance corrente per trade
    minWarmup:       Math.max(100, strategy.minWarmup || 0),
    maxBars:         strategy.maxBars || 30,
    slMul:           strategy.slMul || 1.5,
    tpMul:           strategy.tpMul || 3.0,
    symbol:          null,
    brokerId:        'fpmarkets_raw',
    ruinThreshold:   0.5,          // se balance < 50% starting → blown
    compounding:     true,          // se false, risk fisso su starting balance
    ...opts,
  }
  if (!candles || candles.length < cfg.minWarmup + cfg.maxBars + 10) {
    return { error: 'Candele insufficienti', strategy: strategy.id, symbol: cfg.symbol }
  }

  let balance     = cfg.startingBalance
  let peak        = balance
  let maxDrawdown = 0
  let blown       = false
  let blownAt     = null

  const trades = []
  const equityCurve = [{ time: candles[cfg.minWarmup].time, balance }]

  for (let i = cfg.minWarmup; i < candles.length - cfg.maxBars; i++) {
    if (blown) break
    const sig = strategy.fn(candles, i)
    if (!sig?.direction) continue
    const trade = simulateTrade(candles, i, sig.direction, cfg.slMul, cfg.tpMul, cfg.maxBars, cfg.symbol, cfg.brokerId)
    if (!trade) continue

    // Position sizing: 1R = riskPerTrade × balance corrente (compounding) o starting (no-comp)
    const riskBase = cfg.compounding ? balance : cfg.startingBalance
    const riskEUR  = riskBase * cfg.riskPerTrade
    const pnlEUR   = trade.rr * riskEUR

    balance += pnlEUR

    trades.push({
      time:       candles[i].time,
      direction:  sig.direction,
      reason:     sig.reason,
      entry:      candles[i].close,
      ...trade,
      riskEUR:    Math.round(riskEUR * 100) / 100,
      pnlEUR:     Math.round(pnlEUR  * 100) / 100,
      balanceAfter: Math.round(balance * 100) / 100,
    })

    if (balance > peak) peak = balance
    const dd = peak > 0 ? (peak - balance) / peak : 0
    if (dd > maxDrawdown) maxDrawdown = dd

    equityCurve.push({ time: candles[i].time, balance: Math.round(balance * 100) / 100 })

    // Ruin check
    if (balance < cfg.startingBalance * cfg.ruinThreshold) {
      blown = true
      blownAt = candles[i].time
    }
  }

  // Aggregati
  const total      = trades.length
  const wins       = trades.filter(t => t.outcome === 'tp').length
  const losses     = trades.filter(t => t.outcome === 'sl').length
  const closed     = wins + losses
  const winRate    = closed > 0 ? wins / closed : 0
  const grossWinR  = trades.filter(t => t.rr > 0).reduce((s, t) => s + t.rr, 0)
  const grossLossR = Math.abs(trades.filter(t => t.rr < 0).reduce((s, t) => s + t.rr, 0))
  const profitFactor = grossLossR > 0 ? grossWinR / grossLossR : (grossWinR > 0 ? Infinity : 0)
  const avgRR      = total > 0 ? trades.reduce((s, t) => s + t.rr, 0) / total : 0

  // Periodo coperto
  const totalSeconds = candles[candles.length - 1].time - candles[cfg.minWarmup].time
  const totalDays    = Math.max(1, totalSeconds / 86400)
  const tradesPerDay = total / totalDays

  return {
    strategy: strategy.id,
    strategyName: strategy.name,
    symbol: cfg.symbol,
    startingBalance: cfg.startingBalance,
    finalBalance:    Math.round(balance * 100) / 100,
    pnlEUR:          Math.round((balance - cfg.startingBalance) * 100) / 100,
    pnlPct:          Math.round((balance - cfg.startingBalance) / cfg.startingBalance * 10000) / 100,
    peakBalance:     Math.round(peak * 100) / 100,
    maxDrawdownPct:  Math.round(maxDrawdown * 10000) / 100,
    blown,
    blownAt,
    trades,
    equityCurve,
    summary: {
      total, wins, losses,
      winRate,
      profitFactor,
      avgRR,
      tradesPerDay,
      significance: significanceLevel(total),
    },
  }
}

/**
 * Esegue la simulazione per più (strategy, symbol) combinations in parallelo logico.
 * @returns {Array} risultati flat per leaderboard
 */
export function simulatePortfolio(strategies, candlesByPair, opts = {}) {
  const results = []
  for (const strategy of strategies) {
    for (const [symbol, candles] of Object.entries(candlesByPair)) {
      if (!candles || candles.length === 0) continue
      // Skip se la strategia non è compatibile con il pair (per scalping)
      if (typeof strategy.compatible === 'function' && !strategy.compatible(symbol)) continue
      const r = simulateAccount(strategy, candles, { ...opts, symbol })
      if (!r.error) results.push(r)
    }
  }
  return results
}
