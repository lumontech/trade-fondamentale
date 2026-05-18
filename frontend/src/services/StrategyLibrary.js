// StrategyLibrary — collezione di strategie operative classiche, ognuna esprimibile
// come `signal(candles, i) → { direction: 'long'|'short'|null, reason }`.
// Ogni strategia viene poi backtestata con la stessa logica ATR-based di BacktestEngine.
import { calculateRSI, calculateBB, calculateMACD, calculateEMA } from '../utils/indicators'
import { getCostInR } from './TradingCosts'
import { significanceLevel, winRateConfidenceInterval, isWinRateSignificantlyAboveRandom,
         walkForwardSplit, calculateRiskMetrics } from './BacktestStatistics'

// ── Helper indicators che operano su slice fino a indice i ─────────
function ema(candles, period, i) {
  // EMA al punto i (close-based)
  if (i < period - 1) return null
  const k = 2 / (period + 1)
  let sum = 0
  for (let j = i - period + 1; j <= i; j++) sum += candles[j].close
  let e = sum / period
  // Per accuracy, ricalcoliamo: in realtà è una sliding window SMA, non EMA storica.
  // Per backtest leggero va bene, ma vogliamo l'EMA reale al punto i.
  // Soluzione: calcoliamo EMA da inizio fino a i (one-shot, accettabile su lookback ridotto)
  if (i < period) return null
  // Initial SMA
  let s0 = 0
  for (let j = 0; j < period; j++) s0 += candles[j].close
  let v = s0 / period
  for (let j = period; j <= i; j++) v = candles[j].close * k + v * (1 - k)
  return v
}

function rsi(candles, period, i) {
  if (i < period) return null
  let gains = 0, losses = 0
  for (let j = 1; j <= period; j++) {
    const d = candles[j].close - candles[j - 1].close
    if (d > 0) gains += d; else losses -= d
  }
  let avgG = gains / period, avgL = losses / period
  for (let j = period + 1; j <= i; j++) {
    const d = candles[j].close - candles[j - 1].close
    avgG = (avgG * (period - 1) + Math.max(0, d)) / period
    avgL = (avgL * (period - 1) + Math.max(0, -d)) / period
  }
  if (avgL === 0) return 100
  return 100 - 100 / (1 + avgG / avgL)
}

function bb(candles, period, mult, i) {
  if (i < period - 1) return null
  const closes = candles.slice(i - period + 1, i + 1).map(c => c.close)
  const mean = closes.reduce((a, b) => a + b, 0) / period
  const std = Math.sqrt(closes.reduce((s, v) => s + (v - mean) ** 2, 0) / period)
  return {
    upper: mean + mult * std,
    middle: mean,
    lower: mean - mult * std,
  }
}

function atr(candles, period, i) {
  if (i < period) return null
  let s = 0
  for (let j = i - period + 1; j <= i; j++) {
    const c = candles[j], p = candles[j - 1]
    s += Math.max(c.high - c.low, Math.abs(c.high - p.close), Math.abs(c.low - p.close))
  }
  return s / period
}

function highestHigh(candles, lookback, i) {
  let h = -Infinity
  for (let j = Math.max(0, i - lookback + 1); j <= i; j++) {
    if (candles[j].high > h) h = candles[j].high
  }
  return h
}
function lowestLow(candles, lookback, i) {
  let l = Infinity
  for (let j = Math.max(0, i - lookback + 1); j <= i; j++) {
    if (candles[j].low < l) l = candles[j].low
  }
  return l
}

// ── STRATEGIE ──────────────────────────────────────────────────────

// 1. EMA Golden/Death Cross (50/200) — classico trend following
function strategy_emaCross(candles, i) {
  const fast = ema(candles, 50, i)
  const slow = ema(candles, 200, i)
  const fastPrev = ema(candles, 50, i - 1)
  const slowPrev = ema(candles, 200, i - 1)
  if (fast == null || slow == null || fastPrev == null || slowPrev == null) return null
  // Golden cross: fast scavalca slow al rialzo
  if (fastPrev <= slowPrev && fast > slow) return { direction: 'long', reason: 'Golden cross EMA50/EMA200' }
  // Death cross: fast scavalca slow al ribasso
  if (fastPrev >= slowPrev && fast < slow) return { direction: 'short', reason: 'Death cross EMA50/EMA200' }
  return null
}

// 2. RSI Oversold/Overbought reversion (mean reversion, ranging)
function strategy_rsiReversion(candles, i) {
  const r     = rsi(candles, 14, i)
  const rPrev = rsi(candles, 14, i - 1)
  if (r == null || rPrev == null) return null
  // Long: RSI risale sopra 30 dopo essere stato sotto
  if (rPrev <= 30 && r > 30) return { direction: 'long', reason: 'RSI risale da ipervenduto' }
  // Short: RSI scende sotto 70 dopo essere stato sopra
  if (rPrev >= 70 && r < 70) return { direction: 'short', reason: 'RSI scende da ipercomprato' }
  return null
}

// 3. RSI + BB lower band bounce (Connors-style)
function strategy_rsiBB(candles, i) {
  const r = rsi(candles, 14, i)
  const b = bb(candles, 20, 2, i)
  if (r == null || !b) return null
  const c = candles[i]
  // Long: chiude sotto la lower BB con RSI < 30
  if (c.close < b.lower && r < 35) return { direction: 'long', reason: 'Touch lower BB + RSI ipervenduto' }
  // Short: chiude sopra la upper BB con RSI > 70
  if (c.close > b.upper && r > 65) return { direction: 'short', reason: 'Touch upper BB + RSI ipercomprato' }
  return null
}

// 4. Donchian Breakout 20-bar (Turtle Trading)
function strategy_donchianBreakout(candles, i) {
  if (i < 21) return null
  const hi20 = highestHigh(candles, 20, i - 1)  // highest high precedente
  const lo20 = lowestLow(candles, 20, i - 1)
  const c = candles[i]
  if (c.close > hi20) return { direction: 'long', reason: 'Breakout 20-bar high' }
  if (c.close < lo20) return { direction: 'short', reason: 'Breakdown 20-bar low' }
  return null
}

// 5. SMC Liquidity Sweep + reversal — high del range raggiunto poi rejection
function strategy_smcSweep(candles, i) {
  if (i < 25) return null
  // Trova il high/low più alto degli ultimi 20 bar (escludendo i)
  const hi = highestHigh(candles, 20, i - 1)
  const lo = lowestLow(candles, 20, i - 1)
  const c = candles[i]
  // Sweep bullish: la candela ha un wick che spazza il low precedente ma chiude sopra
  if (c.low < lo && c.close > lo && c.close > c.open) {
    return { direction: 'long', reason: 'Liquidity sweep sotto SSL + reversal' }
  }
  // Sweep bearish: wick sopra hi precedente ma chiude sotto
  if (c.high > hi && c.close < hi && c.close < c.open) {
    return { direction: 'short', reason: 'Liquidity sweep sopra BSL + reversal' }
  }
  return null
}

// 6. Wyckoff Spring — false breakdown + return into range
function strategy_wyckoffSpring(candles, i) {
  if (i < 30) return null
  const c    = candles[i]
  const prev = candles[i - 1]
  // Range degli ultimi 25 bar (escludendo gli ultimi 2)
  const lo = lowestLow(candles, 25, i - 2)
  const hi = highestHigh(candles, 25, i - 2)
  const range = hi - lo
  if (range <= 0) return null
  // Spring: la candela precedente rompe il low, la corrente recupera dentro il range con close > open
  if (prev.low < lo && c.close > lo && c.close > c.open && c.close - c.open > range * 0.05) {
    return { direction: 'long', reason: 'Wyckoff Spring: false breakdown + reentry' }
  }
  // Upthrust (mirror): prev rompe hi, c torna dentro con close < open
  if (prev.high > hi && c.close < hi && c.close < c.open && c.open - c.close > range * 0.05) {
    return { direction: 'short', reason: 'Wyckoff Upthrust: false breakout + rejection' }
  }
  return null
}

// 7. MACD Cross + Trend filter (EMA200)
function strategy_macdTrendFilter(candles, i) {
  if (i < 50) return null
  // MACD line e signal line al punto i e i-1
  const slice = candles.slice(0, i + 1)
  const m = calculateMACD(slice)
  if (!m) return null
  // calculateMACD restituisce solo l'ultimo valore. Ricalcoliamo alla i-1
  const slicePrev = candles.slice(0, i)
  const mPrev = calculateMACD(slicePrev)
  if (!mPrev) return null

  const trend = ema(candles, 200, i)
  if (trend == null) return null
  const price = candles[i].close

  // Long se MACD attraversa al rialzo signal AND price > EMA200
  if (mPrev.histogram <= 0 && m.histogram > 0 && price > trend) {
    return { direction: 'long', reason: 'MACD bullish cross sopra EMA200' }
  }
  // Short se MACD attraversa al ribasso signal AND price < EMA200
  if (mPrev.histogram >= 0 && m.histogram < 0 && price < trend) {
    return { direction: 'short', reason: 'MACD bearish cross sotto EMA200' }
  }
  return null
}

// 8. Inside Bar Breakout (volatility expansion)
function strategy_insideBarBreakout(candles, i) {
  if (i < 3) return null
  const c    = candles[i]
  const m1   = candles[i - 1]    // mother bar
  const m2   = candles[i - 2]
  // Pattern: i-1 è inside di i-2; i rompe range di i-2
  const isInside = m1.high < m2.high && m1.low > m2.low
  if (!isInside) return null
  if (c.close > m2.high) return { direction: 'long',  reason: 'Inside bar breakout (sopra mother bar)' }
  if (c.close < m2.low)  return { direction: 'short', reason: 'Inside bar breakdown (sotto mother bar)' }
  return null
}

// ── Registro strategie ─────────────────────────────────────────────
export const STRATEGIES = [
  {
    id:    'emaCross',
    name:  'Golden / Death Cross',
    icon:  '✕',
    desc:  'Incrocio EMA 50/200. Trend following classico — funziona meglio su 1D/4h e su asset trending (BTC, indici).',
    style: 'trend',
    fn:    strategy_emaCross,
  },
  {
    id:    'rsiReversion',
    name:  'RSI Reversion',
    icon:  '↻',
    desc:  'Long quando RSI risale sopra 30, short quando scende sotto 70. Mean-reversion in mercati ranging.',
    style: 'reversion',
    fn:    strategy_rsiReversion,
  },
  {
    id:    'rsiBB',
    name:  'RSI + Bollinger Band',
    icon:  '∿',
    desc:  'Bounce sulla lower band con RSI ipervenduto. Strategia tipica di EUR/USD ranging (~71% WR storico).',
    style: 'reversion',
    fn:    strategy_rsiBB,
  },
  {
    id:    'donchian',
    name:  'Donchian Breakout 20',
    icon:  '⇅',
    desc:  'Breakout del massimo/minimo a 20 bar. Sistema Turtle — eccellente in trend forti, drawdown alti in lateralità.',
    style: 'breakout',
    fn:    strategy_donchianBreakout,
  },
  {
    id:    'smcSweep',
    name:  'SMC Liquidity Sweep',
    icon:  '⚡',
    desc:  'Smart Money Concept: il prezzo spazza la liquidità sopra/sotto un range e inverte. Setup ad alta probabilità su crypto/forex 1h+.',
    style: 'smc',
    fn:    strategy_smcSweep,
  },
  {
    id:    'wyckoffSpring',
    name:  'Wyckoff Spring',
    icon:  '〰',
    desc:  'False breakdown sotto un range di accumulazione, seguito da reentry. Segnale chiave fase D di Wyckoff.',
    style: 'wyckoff',
    fn:    strategy_wyckoffSpring,
  },
  {
    id:    'macdTrend',
    name:  'MACD + Trend filter',
    icon:  '⤧',
    desc:  'Incrocio MACD nella direzione del trend (EMA200). Filtra il rumore della MACD pura.',
    style: 'trend',
    fn:    strategy_macdTrendFilter,
  },
  {
    id:    'insideBar',
    name:  'Inside Bar Breakout',
    icon:  '⊟',
    desc:  'Compressione di volatilità (inside bar) seguita da breakout della mother bar. Setup di espansione classico.',
    style: 'breakout',
    fn:    strategy_insideBarBreakout,
  },
]

// ── Backtest runner per strategie ──────────────────────────────────
function simulateTrade(candles, i, direction, slMul = 1.5, tpMul = 3.0, maxBars = 30, symbol = null, brokerId = 'fpmarkets_raw') {
  const a = atr(candles, 14, i)
  if (!a || a === 0) return null
  const entry = candles[i].close
  const slDist = a * slMul
  const tpDist = a * tpMul
  const sl = direction === 'long' ? entry - slDist : entry + slDist
  const tp = direction === 'long' ? entry + tpDist : entry - tpDist

  const costInR = symbol ? getCostInR(symbol, a, slDist, brokerId) : 0

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
  // Timeout
  const j = Math.min(i + maxBars, candles.length - 1)
  const exit = candles[j].close
  const pnl = direction === 'long' ? exit - entry : entry - exit
  const rawRR = pnl / slDist
  return { outcome: 'timeout', rr: rawRR - costInR, rawRR, costInR, bars: j - i }
}

/**
 * Backtest di una singola strategia.
 */
export function runStrategyBacktest(strategy, candles, opts = {}) {
  const cfg = {
    minWarmup:    250,    // serve EMA200 + buffer
    maxBars:      30,
    slMultiplier: 1.5,
    tpMultiplier: 3.0,
    symbol:       null,
    brokerId:     'fpmarkets_raw',
    walkForward:  true,
    ...opts,
  }
  if (!candles || candles.length < cfg.minWarmup + cfg.maxBars + 10) {
    return { error: 'Candele insufficienti', trades: [], summary: null }
  }
  const trades = []
  for (let i = cfg.minWarmup; i < candles.length - cfg.maxBars; i++) {
    const sig = strategy.fn(candles, i)
    if (!sig || !sig.direction) continue
    const trade = simulateTrade(candles, i, sig.direction, cfg.slMultiplier, cfg.tpMultiplier, cfg.maxBars, cfg.symbol, cfg.brokerId)
    if (!trade) continue
    trades.push({
      time: candles[i].time,
      bar: i,
      direction: sig.direction,
      reason: sig.reason,
      ...trade,
    })
  }

  const total   = trades.length
  const wins    = trades.filter(t => t.outcome === 'tp').length
  const losses  = trades.filter(t => t.outcome === 'sl').length
  const closed  = wins + losses
  const winRate = closed > 0 ? wins / closed : 0
  const avgRR   = total > 0 ? trades.reduce((s, t) => s + t.rr, 0) / total : 0
  const avgRawRR = total > 0 ? trades.reduce((s, t) => s + (t.rawRR || t.rr), 0) / total : 0
  const avgCost  = total > 0 ? trades.reduce((s, t) => s + (t.costInR || 0), 0) / total : 0
  // Profit factor netto basato sui R reali post-costi
  const grossWin  = trades.filter(t => t.rr > 0).reduce((s, t) => s + t.rr, 0)
  const grossLoss = Math.abs(trades.filter(t => t.rr < 0).reduce((s, t) => s + t.rr, 0))
  const profitFactor = grossLoss > 0 ? grossWin / grossLoss : (grossWin > 0 ? Infinity : 0)

  // Equity curve & DD
  let eq = 0, peak = 0, maxDD = 0
  for (const t of trades) {
    eq += t.rr
    if (eq > peak) peak = eq
    if (peak - eq > maxDD) maxDD = peak - eq
  }

  // Statistiche
  const significance = significanceLevel(total)
  const ci = winRateConfidenceInterval(wins, closed)
  const pTest = isWinRateSignificantlyAboveRandom(wins, closed, 0.5)
  const wf = cfg.walkForward && trades.length >= 20 ? walkForwardSplit(trades, 0.7) : null
  const risk = calculateRiskMetrics(trades.map(t => t.rr))

  return {
    trades,
    summary: {
      strategyId: strategy.id,
      strategyName: strategy.name,
      total,
      wins,
      losses,
      timeouts: total - closed,
      winRate,
      avgRR,
      avgRawRR,
      avgCost,
      profitFactor,
      maxDD,
      finalEquity: eq,
      tradesPerYear: total / Math.max(1, (candles.length / 365)),
      significance,
      confidenceInterval: ci,
      pValue: pTest.pValue,
      isSignificantEdge: pTest.significant,
      walkForward: wf,
      sharpe:  risk.sharpe,
      sortino: risk.sortino,
    },
  }
}

/**
 * Esegue tutte le strategie.
 */
export function runAllStrategies(candles, opts = {}) {
  return STRATEGIES.map(s => ({
    strategy: s,
    result:   runStrategyBacktest(s, candles, opts),
  }))
}

// ── Re-export utilità statistiche per UI ───────────────────────────
export { significanceLevel, winRateConfidenceInterval } from './BacktestStatistics'
