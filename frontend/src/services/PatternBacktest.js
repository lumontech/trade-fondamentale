// PatternBacktest — esegue il backtest pattern-by-pattern sulle candele storiche.
// Per ogni candela, rileva pattern attivi e simula un trade walk-forward
// con SL/TP basati su ATR (stessa logica di BacktestEngine ma raggruppata per pattern).
//
// Output: per ogni pattern name → { occurrences, wins, losses, winRate, avgRR, profitFactor, lastSeen }
// Più ranking aggregati: by frequency, by performance.
import { detectCandlestickPatterns } from './CandlestickPatterns'
import { detectChartPatterns }       from './ChartPatterns'
import { detectHarmonicPatterns }    from './HarmonicPatterns'
import { getCostInR }                from './TradingCosts'
import { significanceLevel, winRateConfidenceInterval, isWinRateSignificantlyAboveRandom,
         walkForwardSplit }          from './BacktestStatistics'

// ── ATR ───────────────────────────────────────────────────────────
function calculateATR(candles, period = 14) {
  if (candles.length < period + 1) return null
  const trs = []
  for (let i = 1; i < candles.length; i++) {
    const c = candles[i], p = candles[i - 1]
    trs.push(Math.max(
      c.high - c.low,
      Math.abs(c.high - p.close),
      Math.abs(c.low  - p.close),
    ))
  }
  let atr = trs.slice(0, period).reduce((s, x) => s + x, 0) / period
  for (let i = period; i < trs.length; i++) {
    atr = (atr * (period - 1) + trs[i]) / period
  }
  return atr
}

// Simula un trade walk-forward, applicando costi spread+slippage+commission
function simulateTrade(candles, i, direction, atrMul = { sl: 1.5, tp: 3.0 }, maxBars = 30, symbol = null, brokerId = 'fpmarkets_raw') {
  const atr = calculateATR(candles.slice(0, i + 1), 14)
  if (!atr || atr === 0) return null
  const entry = candles[i].close
  const slDist = atr * atrMul.sl
  const tpDist = atr * atrMul.tp
  const sl = direction === 'long' ? entry - slDist : entry + slDist
  const tp = direction === 'long' ? entry + tpDist : entry - tpDist

  // Costo trade in R (spread + slippage + commission)
  const costInR = symbol ? getCostInR(symbol, atr, slDist, brokerId) : 0

  for (let j = i + 1; j <= i + maxBars && j < candles.length; j++) {
    const bar = candles[j]
    if (direction === 'long') {
      if (bar.low  <= sl) return { outcome: 'sl', rr: -1 - costInR, rawRR: -1, costInR, pnl: -slDist, bars: j - i }
      if (bar.high >= tp) return { outcome: 'tp', rr: (tpDist / slDist) - costInR, rawRR: tpDist / slDist, costInR, pnl: tpDist, bars: j - i }
    } else {
      if (bar.high >= sl) return { outcome: 'sl', rr: -1 - costInR, rawRR: -1, costInR, pnl: -slDist, bars: j - i }
      if (bar.low  <= tp) return { outcome: 'tp', rr: (tpDist / slDist) - costInR, rawRR: tpDist / slDist, costInR, pnl: tpDist, bars: j - i }
    }
  }
  // Timeout
  const j = Math.min(i + maxBars, candles.length - 1)
  const exit = candles[j].close
  const pnl = direction === 'long' ? exit - entry : entry - exit
  const rawRR = pnl / slDist
  return { outcome: 'timeout', rr: rawRR - costInR, rawRR, costInR, pnl, bars: j - i }
}

// ── Detection a "snapshot" su un range di candele ──────────────────
// Per evitare quadratico costoso, scansioniamo a stride configurabile
// e usiamo le funzioni esistenti (che però guardano già a tutto il passato).
// Per il backtest pattern-by-pattern, usiamo una versione "ultima candela":
// ad ogni step i, controlla se c'è un nuovo pattern formato CHE FINISCE in i.
function detectAtBar(candles, i, types = ['candlestick', 'chart', 'harmonic']) {
  const slice = candles.slice(0, i + 1)
  const found = []
  // Tutti i 3 engine espongono p.candleIndex = bar in cui il pattern si è completato.
  // Cerchiamo pattern che si sono completati ESATTAMENTE in i (per evitare doppi conteggi).
  if (types.includes('candlestick')) {
    const patterns = detectCandlestickPatterns(slice, 3)
    for (const p of patterns) {
      if (p.candleIndex === i) found.push(p)
    }
  }
  if (types.includes('chart')) {
    const patterns = detectChartPatterns(slice, 8)
    for (const p of patterns) {
      if (p.candleIndex === i) found.push(p)
    }
  }
  if (types.includes('harmonic')) {
    const patterns = detectHarmonicPatterns(slice, 8)
    for (const p of patterns) {
      if (p.candleIndex === i) found.push(p)
    }
  }
  return found
}

// ── Main: pattern backtest ─────────────────────────────────────────
/**
 * Esegue backtest pattern-by-pattern.
 * @param {Array} candles - candele storiche
 * @param {Object} opts - { types, minWarmup, maxBars, slMultiplier, tpMultiplier, stride }
 * @param {Function} onProgress - callback(percentage) per UI
 * @returns {Object} { perPattern, byCategory, byFrequency, byPerformance, summary }
 */
export function runPatternBacktest(candles, opts = {}, onProgress = null) {
  const cfg = {
    types:        ['candlestick', 'chart', 'harmonic'],
    minWarmup:    100,
    maxBars:      30,
    slMultiplier: 1.5,
    tpMultiplier: 3.0,
    stride:       1,
    symbol:       null,                  // per applicare costi broker
    brokerId:     'fpmarkets_raw',
    walkForward:  true,                  // calcola split train/test
    ...opts,
  }

  if (!candles || candles.length < cfg.minWarmup + cfg.maxBars + 10) {
    return { error: 'Candele insufficienti', perPattern: {}, summary: null }
  }

  const perPattern = {}  // name → { type, occurrences, wins, losses, totalRR, sumPnL, lastSeen, bias }
  const totalSteps = candles.length - cfg.maxBars - cfg.minWarmup

  for (let i = cfg.minWarmup; i < candles.length - cfg.maxBars; i += cfg.stride) {
    const patterns = detectAtBar(candles, i, cfg.types)

    for (const p of patterns) {
      const name = p.name
      const direction = p.bias === 'bullish' ? 'long' : p.bias === 'bearish' ? 'short' : null
      if (!direction) continue

      const trade = simulateTrade(candles, i, direction, { sl: cfg.slMultiplier, tp: cfg.tpMultiplier }, cfg.maxBars, cfg.symbol, cfg.brokerId)
      if (!trade) continue

      if (!perPattern[name]) {
        perPattern[name] = {
          name,
          type: p.type,
          bias: p.bias,
          reliability: p.reliability,
          occurrences: 0,
          wins: 0,
          losses: 0,
          timeouts: 0,
          totalRR: 0,
          totalRawRR: 0,
          totalCostInR: 0,
          sumPnL: 0,
          firstSeen: candles[i].time,
          lastSeen: candles[i].time,
          trades: [],   // per walk-forward & metriche dettagliate
        }
      }
      const s = perPattern[name]
      s.occurrences++
      s.totalRR    += trade.rr
      s.totalRawRR += (trade.rawRR || trade.rr)
      s.totalCostInR += (trade.costInR || 0)
      s.sumPnL  += trade.pnl
      s.lastSeen = candles[i].time
      s.trades.push({ time: candles[i].time, bar: i, ...trade })
      if (trade.outcome === 'tp')      s.wins++
      else if (trade.outcome === 'sl') s.losses++
      else                             s.timeouts++
    }

    if (onProgress && i % 100 === 0) {
      onProgress(Math.round(((i - cfg.minWarmup) / totalSteps) * 100))
    }
  }

  // Calcola metriche derivate (con costi inclusi e statistiche)
  const stats = Object.values(perPattern).map(s => {
    const closed = s.wins + s.losses
    const winRate = closed > 0 ? s.wins / closed : 0
    const avgRR = s.occurrences > 0 ? s.totalRR / s.occurrences : 0          // post-costi
    const avgRawRR = s.occurrences > 0 ? s.totalRawRR / s.occurrences : 0    // pre-costi
    const avgCost  = s.occurrences > 0 ? s.totalCostInR / s.occurrences : 0
    // Profit factor netto: somma vincite reali / somma perdite reali (entrambe post-costi)
    const grossWin  = s.trades.filter(t => t.rr > 0).reduce((sum, t) => sum + t.rr, 0)
    const grossLoss = Math.abs(s.trades.filter(t => t.rr < 0).reduce((sum, t) => sum + t.rr, 0))
    const profitFactor = grossLoss > 0 ? grossWin / grossLoss : (grossWin > 0 ? Infinity : 0)
    // Significatività
    const significance = significanceLevel(s.occurrences)
    const ci = winRateConfidenceInterval(s.wins, closed)
    const pTest = isWinRateSignificantlyAboveRandom(s.wins, closed, 0.5)
    // Walk-forward
    const wf = cfg.walkForward && s.trades.length >= 10
      ? walkForwardSplit(s.trades, 0.7) : null

    // Snella: rimuoviamo trades dall'output finale per non bloatare
    const { trades, ...rest } = s
    return {
      ...rest,
      closed,
      winRate,
      avgRR,           // post-costi
      avgRawRR,        // pre-costi (per confronto)
      avgCost,         // costo medio per trade in R
      profitFactor,
      expectancy: avgRR,
      significance,    // { level, label, color, stars, hint }
      confidenceInterval: ci,  // { lower, upper, point, width }
      pValue: pTest.pValue,
      isSignificantEdge: pTest.significant,
      walkForward: wf, // { train, test, divergence, overfit } o null
    }
  })

  // Ranking
  const byFrequency = [...stats].sort((a, b) => b.occurrences - a.occurrences)
  const byPerformance = [...stats]
    .filter(s => s.occurrences >= 5)
    .sort((a, b) => b.expectancy - a.expectancy)

  const byCategory = {
    candlestick: stats.filter(s => s.type === 'candlestick').sort((a, b) => b.occurrences - a.occurrences),
    chart:       stats.filter(s => s.type === 'chart').sort((a, b) => b.occurrences - a.occurrences),
    harmonic:    stats.filter(s => s.type === 'harmonic').sort((a, b) => b.occurrences - a.occurrences),
  }

  const totalOccurrences = stats.reduce((s, x) => s + x.occurrences, 0)
  const totalWins        = stats.reduce((s, x) => s + x.wins, 0)
  const totalLosses      = stats.reduce((s, x) => s + x.losses, 0)
  const totalClosed      = totalWins + totalLosses
  const overallWR        = totalClosed > 0 ? totalWins / totalClosed : 0

  return {
    perPattern: stats,
    byFrequency,
    byPerformance,
    byCategory,
    summary: {
      totalOccurrences,
      uniquePatterns: stats.length,
      overallWinRate: overallWR,
      candlesAnalyzed: candles.length,
      periodStart: candles[cfg.minWarmup]?.time,
      periodEnd:   candles[candles.length - 1]?.time,
    },
  }
}
