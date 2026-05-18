// Strategie portate dal frontend (StrategyLibrary.js + ScalpingLibrary.js).
// Ognuna è (candles, i) -> { direction, reason } | null

// ── Indicators helpers ─────────────────────────────────────────────
function ema(candles, period, i) {
  if (i < period) return null
  const k = 2 / (period + 1)
  let s = 0
  for (let j = 0; j < period; j++) s += candles[j].close
  let v = s / period
  for (let j = period; j <= i; j++) v = candles[j].close * k + v * (1 - k)
  return v
}

function rsi(candles, period, i) {
  if (i < period) return null
  let g = 0, l = 0
  for (let j = 1; j <= period; j++) {
    const d = candles[j].close - candles[j - 1].close
    if (d > 0) g += d; else l -= d
  }
  let aG = g / period, aL = l / period
  for (let j = period + 1; j <= i; j++) {
    const d = candles[j].close - candles[j - 1].close
    aG = (aG * (period - 1) + Math.max(0, d)) / period
    aL = (aL * (period - 1) + Math.max(0, -d)) / period
  }
  if (aL === 0) return 100
  return 100 - 100 / (1 + aG / aL)
}

function bb(candles, period, mult, i) {
  if (i < period - 1) return null
  let sum = 0
  for (let j = i - period + 1; j <= i; j++) sum += candles[j].close
  const mean = sum / period
  let varSum = 0
  for (let j = i - period + 1; j <= i; j++) varSum += (candles[j].close - mean) ** 2
  const std = Math.sqrt(varSum / period)
  return { upper: mean + mult * std, mid: mean, lower: mean - mult * std }
}

function highestHigh(candles, lb, i) {
  let h = -Infinity
  for (let j = Math.max(0, i - lb + 1); j <= i; j++) if (candles[j].high > h) h = candles[j].high
  return h
}
function lowestLow(candles, lb, i) {
  let l = Infinity
  for (let j = Math.max(0, i - lb + 1); j <= i; j++) if (candles[j].low < l) l = candles[j].low
  return l
}

function macdAt(candles, i, fast = 12, slow = 26, sig = 9) {
  if (i < slow + sig) return null
  const closes = candles.slice(0, i + 1).map(c => c.close)
  const emaArr = (arr, p) => {
    const k = 2 / (p + 1)
    let s = 0
    for (let j = 0; j < p; j++) s += arr[j]
    let v = s / p
    const out = [v]
    for (let j = p; j < arr.length; j++) { v = arr[j] * k + v * (1 - k); out.push(v) }
    return out
  }
  const eFast = emaArr(closes, fast)
  const eSlow = emaArr(closes, slow)
  const offset = slow - fast
  const macdLine = eFast.slice(offset).map((v, idx) => v - eSlow[idx])
  const sigLine = emaArr(macdLine, sig)
  const last = macdLine[macdLine.length - 1] - sigLine[sigLine.length - 1]
  const prev = macdLine[macdLine.length - 2] - sigLine[sigLine.length - 2]
  return { histogram: last, prevHistogram: prev }
}

function atrAt(candles, period, i) {
  if (i < period) return null
  let s = 0
  for (let j = i - period + 1; j <= i; j++) {
    const c = candles[j], p = candles[j - 1]
    s += Math.max(c.high - c.low, Math.abs(c.high - p.close), Math.abs(c.low - p.close))
  }
  return s / period
}

// ── SWING strategies (TF 1h-4h-1D) ─────────────────────────────────
function strat_emaCross(c, i) {
  const f = ema(c, 50, i), s = ema(c, 200, i)
  const fp = ema(c, 50, i-1), sp = ema(c, 200, i-1)
  if ([f, s, fp, sp].some(v => v == null)) return null
  if (fp <= sp && f > s) return { direction: 'long',  reason: 'Golden cross EMA50/200' }
  if (fp >= sp && f < s) return { direction: 'short', reason: 'Death cross EMA50/200' }
  return null
}

function strat_rsiReversion(c, i) {
  const r = rsi(c, 14, i), rp = rsi(c, 14, i-1)
  if (r == null || rp == null) return null
  if (rp <= 30 && r > 30) return { direction: 'long',  reason: 'RSI risale da ipervenduto' }
  if (rp >= 70 && r < 70) return { direction: 'short', reason: 'RSI scende da ipercomprato' }
  return null
}

function strat_rsiBB(c, i) {
  const r = rsi(c, 14, i), b = bb(c, 20, 2, i)
  if (r == null || !b) return null
  const k = c[i]
  if (k.close < b.lower && r < 35) return { direction: 'long',  reason: 'Lower BB + RSI ipervenduto' }
  if (k.close > b.upper && r > 65) return { direction: 'short', reason: 'Upper BB + RSI ipercomprato' }
  return null
}

function strat_donchian(c, i) {
  if (i < 21) return null
  const hi = highestHigh(c, 20, i-1), lo = lowestLow(c, 20, i-1)
  const k = c[i]
  if (k.close > hi) return { direction: 'long',  reason: 'Breakout 20-bar high' }
  if (k.close < lo) return { direction: 'short', reason: 'Breakdown 20-bar low' }
  return null
}

function strat_smcSweep(c, i) {
  if (i < 25) return null
  const hi = highestHigh(c, 20, i-1), lo = lowestLow(c, 20, i-1)
  const k = c[i]
  if (k.low < lo && k.close > lo && k.close > k.open) return { direction: 'long', reason: 'SMC sweep below SSL' }
  if (k.high > hi && k.close < hi && k.close < k.open) return { direction: 'short', reason: 'SMC sweep above BSL' }
  return null
}

function strat_wyckoffSpring(c, i) {
  if (i < 30) return null
  const k = c[i], p = c[i-1]
  const lo = lowestLow(c, 25, i-2), hi = highestHigh(c, 25, i-2)
  const range = hi - lo
  if (range <= 0) return null
  if (p.low < lo && k.close > lo && k.close > k.open && k.close - k.open > range * 0.05) {
    return { direction: 'long', reason: 'Wyckoff Spring: false breakdown + reentry' }
  }
  if (p.high > hi && k.close < hi && k.close < k.open && k.open - k.close > range * 0.05) {
    return { direction: 'short', reason: 'Wyckoff Upthrust' }
  }
  return null
}

function strat_macdTrend(c, i) {
  if (i < 50) return null
  const m = macdAt(c, i)
  if (!m) return null
  const trend = ema(c, 200, i)
  if (trend == null) return null
  const price = c[i].close
  if (m.prevHistogram <= 0 && m.histogram > 0 && price > trend) {
    return { direction: 'long', reason: 'MACD bullish cross sopra EMA200' }
  }
  if (m.prevHistogram >= 0 && m.histogram < 0 && price < trend) {
    return { direction: 'short', reason: 'MACD bearish cross sotto EMA200' }
  }
  return null
}

function strat_insideBar(c, i) {
  if (i < 3) return null
  const k = c[i], m1 = c[i-1], m2 = c[i-2]
  const isInside = m1.high < m2.high && m1.low > m2.low
  if (!isInside) return null
  if (k.close > m2.high) return { direction: 'long',  reason: 'Inside bar breakout up' }
  if (k.close < m2.low)  return { direction: 'short', reason: 'Inside bar breakdown' }
  return null
}

// ── SCALP strategies (TF 5m-15m) ───────────────────────────────────
function getSessionAt(timestamp) {
  const h = new Date(timestamp * 1000).getUTCHours()
  if (h >= 13 && h < 16) return 'overlap'
  if (h >= 8  && h < 13) return 'london'
  if (h >= 16 && h < 21) return 'ny'
  if (h >= 0  && h < 8)  return 'asian'
  return 'late'
}

function strat_ema921(c, i) {
  const e9 = ema(c, 9, i), e21 = ema(c, 21, i)
  if (e9 == null || e21 == null) return null
  const k = c[i], p = c[i-1]
  if (e9 > e21 && p.low <= e21 * 1.001 && k.close > e9 && k.close > k.open) {
    return { direction: 'long', reason: 'EMA9/21 pullback long' }
  }
  if (e9 < e21 && p.high >= e21 * 0.999 && k.close < e9 && k.close < k.open) {
    return { direction: 'short', reason: 'EMA9/21 pullback short' }
  }
  return null
}

function strat_vwap(c, i) {
  if (i < 30) return null
  const session = getSessionAt(c[i].time)
  if (session === 'late' || session === 'asian') return null
  // VWAP della sessione corrente (start = 8 UTC London o 13 UTC NY)
  const sessionStartHour = session === 'london' ? 8 : 13
  const d = new Date(c[i].time * 1000)
  const startTs = Math.floor(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), sessionStartHour) / 1000)
  let pv = 0, vol = 0
  for (let j = i; j >= 0; j--) {
    if (c[j].time < startTs) break
    const tp = (c[j].high + c[j].low + c[j].close) / 3
    const v = c[j].volume || 1
    pv += tp * v
    vol += v
  }
  if (vol === 0 || i - (function(){
    for (let j = i; j >= 0; j--) if (c[j].time < startTs) return j+1
    return 0
  })() < 5) return null
  const vw = pv / vol
  const k = c[i], p = c[i-1]
  const a = atrAt(c, 14, i)
  if (!a) return null
  const dist = Math.abs(k.close - vw) / a
  if (p.low <= vw && k.close > vw && k.close > k.open && dist < 0.5) {
    return { direction: 'long', reason: 'VWAP bounce long' }
  }
  if (p.high >= vw && k.close < vw && k.close < k.open && dist < 0.5) {
    return { direction: 'short', reason: 'VWAP bounce short' }
  }
  return null
}

function strat_bbReversal(c, i) {
  const b = bb(c, 20, 2, i), r = rsi(c, 14, i)
  if (!b || r == null) return null
  const k = c[i]
  if (k.close < b.lower && r < 30) return { direction: 'long',  reason: 'BB lower + RSI extreme' }
  if (k.close > b.upper && r > 70) return { direction: 'short', reason: 'BB upper + RSI extreme' }
  return null
}

function strat_liqSweep(c, i) {
  if (i < 25) return null
  const hi = highestHigh(c, 20, i-1), lo = lowestLow(c, 20, i-1)
  const k = c[i]
  if (k.low < lo && k.close > lo && k.close > k.open) {
    const wick = (Math.min(k.open, k.close) - k.low) / (k.high - k.low + 1e-9)
    if (wick > 0.4) return { direction: 'long', reason: 'SSL sweep + bullish reversal' }
  }
  if (k.high > hi && k.close < hi && k.close < k.open) {
    const wick = (k.high - Math.max(k.open, k.close)) / (k.high - k.low + 1e-9)
    if (wick > 0.4) return { direction: 'short', reason: 'BSL sweep + bearish reversal' }
  }
  return null
}

function strat_threeBarRev(c, i) {
  if (i < 3) return null
  const a = c[i-2], b = c[i-1], k = c[i]
  const aBody = Math.abs(a.close - a.open), bBody = Math.abs(b.close - b.open)
  if (aBody < bBody * 2) return null
  if (a.close < a.open && bBody < aBody * 0.5 && k.close > k.open && k.close > a.open) {
    return { direction: 'long', reason: 'Three-bar reversal bullish' }
  }
  if (a.close > a.open && bBody < aBody * 0.5 && k.close < k.open && k.close < a.open) {
    return { direction: 'short', reason: 'Three-bar reversal bearish' }
  }
  return null
}

// ── Strategy Registry ──────────────────────────────────────────────
export const STRATEGIES = [
  // Swing (TF 1h+)
  { id: 'emaCross',      name: 'Golden / Death Cross', category: 'swing', slMul: 1.5, tpMul: 3.0, fn: strat_emaCross },
  { id: 'rsiReversion',  name: 'RSI Reversion',         category: 'swing', slMul: 1.5, tpMul: 3.0, fn: strat_rsiReversion },
  { id: 'rsiBB',         name: 'RSI + BB',              category: 'swing', slMul: 1.5, tpMul: 3.0, fn: strat_rsiBB },
  { id: 'donchian',      name: 'Donchian Breakout 20',  category: 'swing', slMul: 1.5, tpMul: 3.0, fn: strat_donchian },
  { id: 'smcSweep',      name: 'SMC Liquidity Sweep',   category: 'swing', slMul: 1.5, tpMul: 3.0, fn: strat_smcSweep },
  { id: 'wyckoffSpring', name: 'Wyckoff Spring',        category: 'swing', slMul: 1.5, tpMul: 3.0, fn: strat_wyckoffSpring },
  { id: 'macdTrend',     name: 'MACD + Trend',          category: 'swing', slMul: 1.5, tpMul: 3.0, fn: strat_macdTrend },
  { id: 'insideBar',     name: 'Inside Bar Breakout',   category: 'swing', slMul: 1.5, tpMul: 3.0, fn: strat_insideBar },

  // Scalp (TF 5m-15m)
  { id: 'ema921',        name: 'EMA 9/21 Pullback',     category: 'scalp', slMul: 0.8, tpMul: 1.5, fn: strat_ema921 },
  { id: 'vwap',          name: 'VWAP Bounce',           category: 'scalp', slMul: 0.7, tpMul: 1.2, fn: strat_vwap },
  { id: 'bbReversal',    name: 'BB Outer + RSI',        category: 'scalp', slMul: 0.8, tpMul: 1.4, fn: strat_bbReversal },
  { id: 'liqSweep',      name: 'Liquidity Sweep',       category: 'scalp', slMul: 0.8, tpMul: 1.5, fn: strat_liqSweep },
  { id: 'threeBarRev',   name: 'Three Bar Reversal',    category: 'scalp', slMul: 0.9, tpMul: 1.5, fn: strat_threeBarRev },
]

export function findStrategy(id) {
  return STRATEGIES.find(s => s.id === id)
}

// Helper esposti per il sim
export { atrAt }
