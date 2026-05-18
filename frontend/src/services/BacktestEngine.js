// Backtest reale su candele storiche.
// Per ogni bar, calcola il segnale tecnico e simula trade walk-forward
// con SL/TP basati su ATR. Esiti determinati dai prezzi reali del mercato.
import { calculateSignal } from '../utils/indicators'

// ── ATR (Average True Range) ──────────────────────────────────────
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
  // Wilder smoothing
  let atr = trs.slice(0, period).reduce((s, x) => s + x, 0) / period
  const series = [atr]
  for (let i = period; i < trs.length; i++) {
    atr = (atr * (period - 1) + trs[i]) / period
    series.push(atr)
  }
  return series[series.length - 1]
}

// ── Walk-forward simulation ───────────────────────────────────────
const DEFAULT_OPTS = {
  atrPeriod:    14,
  slMultiplier: 1.5,
  tpMultiplier: 3.0,
  maxBars:      30,
  minWarmup:    50,
}

/**
 * Esegue il backtest su un array di candele.
 * Restituisce trade list + stats aggregate per label di segnale.
 */
export function runBacktest(candles, opts = {}) {
  const cfg = { ...DEFAULT_OPTS, ...opts }
  if (candles.length < cfg.minWarmup + cfg.maxBars + 10) {
    return { trades: [], byLabel: {}, summary: null, error: 'Candele insufficienti' }
  }

  const trades = []

  for (let i = cfg.minWarmup; i < candles.length - cfg.maxBars; i++) {
    const slice  = candles.slice(0, i + 1)
    const signal = calculateSignal(slice)
    if (!signal || signal.label === 'NEUTRO') continue

    const atr = calculateATR(slice, cfg.atrPeriod)
    if (!atr || atr === 0) continue

    const entry     = candles[i].close
    const direction = signal.label.includes('COMPRA') ? 'long' : 'short'
    const slDist    = atr * cfg.slMultiplier
    const tpDist    = atr * cfg.tpMultiplier
    const sl        = direction === 'long' ? entry - slDist : entry + slDist
    const tp        = direction === 'long' ? entry + tpDist : entry - tpDist

    // Walk-forward: cerca colpo a SL o TP usando high/low REALI delle candele
    let outcome   = null
    let exitPrice = null
    let exitBar   = null
    for (let j = i + 1; j <= i + cfg.maxBars && j < candles.length; j++) {
      const bar = candles[j]
      if (direction === 'long') {
        // Logica conservativa: se in una stessa candela ho sia SL che TP, considero SL hit prima
        if (bar.low  <= sl) { outcome = 'sl'; exitPrice = sl; exitBar = j; break }
        if (bar.high >= tp) { outcome = 'tp'; exitPrice = tp; exitBar = j; break }
      } else {
        if (bar.high >= sl) { outcome = 'sl'; exitPrice = sl; exitBar = j; break }
        if (bar.low  <= tp) { outcome = 'tp'; exitPrice = tp; exitBar = j; break }
      }
    }

    if (outcome === null) {
      // Timeout: chiudi al close della maxBars-esima candela
      const j = Math.min(i + cfg.maxBars, candles.length - 1)
      exitPrice = candles[j].close
      exitBar   = j
      outcome   = 'timeout'
    }

    const pnl = direction === 'long' ? exitPrice - entry : entry - exitPrice
    const rr  = pnl / slDist

    trades.push({
      time:      candles[i].time,
      bar:       i,
      signal:    signal.label,
      direction,
      entry,
      sl,
      tp,
      exitPrice,
      exitBar,
      bars:      exitBar - i,
      outcome,                       // 'sl' | 'tp' | 'timeout'
      pnl,
      rr,
      win:       pnl > 0,
    })
  }

  // ── Aggregazione per label di segnale ──────────────────────────
  const byLabel = {}
  for (const t of trades) {
    if (!byLabel[t.signal]) byLabel[t.signal] = []
    byLabel[t.signal].push(t)
  }

  const aggregateStats = (list) => {
    const total     = list.length
    const wins      = list.filter(t => t.win).length
    const losses    = total - wins
    const winRate   = total > 0 ? wins / total : 0
    const grossWin  = list.filter(t => t.pnl > 0).reduce((s,t) => s + t.pnl, 0)
    const grossLoss = Math.abs(list.filter(t => t.pnl < 0).reduce((s,t) => s + t.pnl, 0))
    const profitFactor = grossLoss > 0 ? grossWin / grossLoss : (grossWin > 0 ? Infinity : 0)
    const avgRR     = total > 0 ? list.reduce((s,t) => s + t.rr, 0) / total : 0
    const expectancy = total > 0 ? list.reduce((s,t) => s + t.pnl, 0) / total : 0

    // Equity curve & max drawdown (in R)
    let equity = 0, peak = 0, dd = 0, maxDD = 0
    for (const t of list) {
      equity += t.rr
      if (equity > peak) peak = equity
      dd = peak - equity
      if (dd > maxDD) maxDD = dd
    }

    // Sharpe & Sortino ratios sui rendimenti R per trade (annualizzati semplificati)
    let sharpe = null, sortino = null
    if (total >= 5) {
      const rs = list.map(t => t.rr)
      const mean = rs.reduce((s, x) => s + x, 0) / total
      const variance = rs.reduce((s, x) => s + (x - mean) ** 2, 0) / total
      const std = Math.sqrt(variance)
      sharpe = std > 0 ? mean / std : null
      // Sortino: solo deviazione downside
      const negs = rs.filter(x => x < 0)
      if (negs.length > 0) {
        const downStd = Math.sqrt(negs.reduce((s, x) => s + x ** 2, 0) / negs.length)
        sortino = downStd > 0 ? mean / downStd : null
      } else if (mean > 0) {
        sortino = Infinity
      }
    }

    // Monte Carlo: shuffle dei trade 1000 volte → distribuzione max DD e final equity
    let monteCarloMaxDD95 = null    // 95° percentile worst case DD
    let monteCarloFinalMin = null   // peggior 5% di final equity
    if (total >= 10) {
      const N = 500
      const ddSamples = []
      const finalSamples = []
      for (let n = 0; n < N; n++) {
        const shuffled = [...list].sort(() => Math.random() - 0.5)
        let eq = 0, pk = 0, mxDD = 0
        for (const t of shuffled) {
          eq += t.rr
          if (eq > pk) pk = eq
          if (pk - eq > mxDD) mxDD = pk - eq
        }
        ddSamples.push(mxDD)
        finalSamples.push(eq)
      }
      ddSamples.sort((a, b) => a - b)
      finalSamples.sort((a, b) => a - b)
      monteCarloMaxDD95 = ddSamples[Math.floor(N * 0.95)]
      monteCarloFinalMin = finalSamples[Math.floor(N * 0.05)]
    }

    return {
      total, wins, losses, winRate, profitFactor, avgRR, expectancy, maxDD,
      sharpe:  sharpe  != null ? Math.round(sharpe  * 100) / 100 : null,
      sortino: sortino === Infinity ? Infinity : sortino != null ? Math.round(sortino * 100) / 100 : null,
      mc_worst_dd_95:    monteCarloMaxDD95   != null ? Math.round(monteCarloMaxDD95   * 10) / 10 : null,
      mc_worst_final_5:  monteCarloFinalMin  != null ? Math.round(monteCarloFinalMin  * 10) / 10 : null,
    }
  }

  const result = {}
  for (const [label, list] of Object.entries(byLabel)) {
    result[label] = aggregateStats(list)
  }
  const summary = aggregateStats(trades)

  return { trades, byLabel: result, summary }
}

// ── Cache helpers ─────────────────────────────────────────────────
const CACHE_KEY = 'itp_backtest_cache_v1'

function loadCache() {
  try { return JSON.parse(localStorage.getItem(CACHE_KEY) || '{}') } catch { return {} }
}
function saveCache(c) {
  try { localStorage.setItem(CACHE_KEY, JSON.stringify(c)) } catch {}
}

/**
 * Restituisce stats backtest, usando cache se disponibile e ancora valida.
 */
export function getBacktestStats(symbol, timeframe, candles) {
  if (!candles || candles.length < 80) return null
  const cache = loadCache()
  const key = `${symbol}_${timeframe}`
  const lastCandleTime = candles[candles.length - 1].time
  const cached = cache[key]
  if (cached && cached.lastCandleTime === lastCandleTime && cached.count === candles.length) {
    return cached.stats
  }
  const result = runBacktest(candles)
  // Salva solo le stats aggregate (i trade pesano troppo)
  const lite = { byLabel: result.byLabel, summary: result.summary }
  cache[key] = {
    lastCandleTime,
    count: candles.length,
    stats: lite,
    timestamp: Date.now(),
  }
  saveCache(cache)
  return lite
}

export function getFullBacktest(candles, opts = {}) {
  return runBacktest(candles, opts)
}
