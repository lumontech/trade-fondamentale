// ── EMA ──────────────────────────────────────────────────────────
export function calculateEMA(candles, period) {
  if (!candles || candles.length < period) return []
  const k = 2 / (period + 1)
  const result = []

  let sum = 0
  for (let i = 0; i < period; i++) sum += candles[i].close
  let ema = sum / period
  result.push({ time: candles[period - 1].time, value: ema })

  for (let i = period; i < candles.length; i++) {
    ema = candles[i].close * k + ema * (1 - k)
    result.push({ time: candles[i].time, value: ema })
  }
  return result
}

function emaFromArray(arr, period) {
  if (arr.length < period) return []
  const k = 2 / (period + 1)
  let sum = 0
  for (let i = 0; i < period; i++) sum += arr[i]
  let ema = sum / period
  const result = [ema]
  for (let i = period; i < arr.length; i++) {
    ema = arr[i] * k + ema * (1 - k)
    result.push(ema)
  }
  return result
}

// ── RSI ──────────────────────────────────────────────────────────
export function calculateRSI(candles, period = 14) {
  if (!candles || candles.length < period + 1) return { value: 50, signal: 'NEUTRO', color: '#f5c842' }
  const closes = candles.map(c => c.close)
  let gains = 0, losses = 0

  for (let i = 1; i <= period; i++) {
    const d = closes[i] - closes[i - 1]
    if (d > 0) gains += d; else losses -= d
  }

  let avgGain = gains / period
  let avgLoss = losses / period

  for (let i = period + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1]
    avgGain = (avgGain * (period - 1) + Math.max(0, d)) / period
    avgLoss = (avgLoss * (period - 1) + Math.max(0, -d)) / period
  }

  if (avgLoss === 0) return { value: 100, signal: 'IPERCOMPRATO', color: '#ff3355' }
  const rsi = 100 - 100 / (1 + avgGain / avgLoss)

  let signal, color
  if (rsi > 70)      { signal = 'IPERCOMPRATO'; color = '#ff3355' }
  else if (rsi < 30) { signal = 'IPERVENDUTO';  color = '#00e096' }
  else if (rsi > 55) { signal = 'BULLISH';      color = '#00e096' }
  else if (rsi < 45) { signal = 'BEARISH';      color = '#ff7755' }
  else               { signal = 'NEUTRO';       color = '#f5c842' }

  return { value: parseFloat(rsi.toFixed(1)), signal, color }
}

// ── MACD ─────────────────────────────────────────────────────────
export function calculateMACD(candles, fast = 12, slow = 26, signal = 9) {
  if (!candles || candles.length < slow + signal) return null
  const closes = candles.map(c => c.close)
  const emaFast = emaFromArray(closes, fast)
  const emaSlow = emaFromArray(closes, slow)

  const offset = slow - fast
  const macdLine = emaFast.slice(offset).map((v, i) => v - emaSlow[i])
  const signalLine = emaFromArray(macdLine, signal)

  const lastMacd   = macdLine[macdLine.length - 1]
  const lastSignal = signalLine[signalLine.length - 1]
  const histogram  = lastMacd - lastSignal
  const prevHist   = macdLine[macdLine.length - 2] - signalLine[signalLine.length - 2]

  return {
    macd: lastMacd,
    signal: lastSignal,
    histogram,
    trend:    histogram > 0 ? 'BULLISH' : 'BEARISH',
    momentum: histogram > prevHist ? 'CRESCENTE' : 'CALANTE',
    color:    histogram > 0 ? '#00e096' : '#ff3355',
  }
}

// ── Bollinger Bands ───────────────────────────────────────────────
export function calculateBB(candles, period = 20, mult = 2) {
  if (!candles || candles.length < period) return null
  const closes = candles.slice(-period).map(c => c.close)
  const mean   = closes.reduce((a, b) => a + b, 0) / period
  const std    = Math.sqrt(closes.reduce((s, v) => s + (v - mean) ** 2, 0) / period)
  const last   = candles[candles.length - 1].close

  const upper = mean + mult * std
  const lower = mean - mult * std
  const pos   = (last - lower) / (upper - lower) // 0=lower, 1=upper

  let signal, color
  if (pos > 0.85)      { signal = 'UPPER BAND'; color = '#ff3355' }
  else if (pos < 0.15) { signal = 'LOWER BAND'; color = '#00e096' }
  else if (pos > 0.5)  { signal = 'MID-UPPER';  color = '#f5c842' }
  else                 { signal = 'MID-LOWER';  color = '#f5c842' }

  return { upper, middle: mean, lower, bandwidth: (mult * 2 * std / mean) * 100, pos, signal, color }
}

// ── Support / Resistance ─────────────────────────────────────────
export function findLevels(candles, lookback = 50) {
  if (!candles || candles.length < lookback) return { supports: [], resistances: [] }
  const recent = candles.slice(-lookback)
  const highs = recent.map(c => c.high)
  const lows  = recent.map(c => c.low)
  const last  = candles[candles.length - 1].close

  const pivots = []
  for (let i = 2; i < recent.length - 2; i++) {
    const isHigh = highs[i] > highs[i-1] && highs[i] > highs[i-2] && highs[i] > highs[i+1] && highs[i] > highs[i+2]
    const isLow  = lows[i]  < lows[i-1]  && lows[i]  < lows[i-2]  && lows[i]  < lows[i+1]  && lows[i]  < lows[i+2]
    if (isHigh) pivots.push({ level: highs[i], type: 'resistance' })
    if (isLow)  pivots.push({ level: lows[i],  type: 'support' })
  }

  const supports    = pivots.filter(p => p.type === 'support' && p.level < last)
    .sort((a, b) => b.level - a.level).slice(0, 3).map(p => p.level)
  const resistances = pivots.filter(p => p.type === 'resistance' && p.level > last)
    .sort((a, b) => a.level - b.level).slice(0, 3).map(p => p.level)

  return { supports, resistances }
}

// ── Pivot Points ──────────────────────────────────────────────────
export function calcPivots(candles) {
  if (!candles || candles.length < 2) return null
  const prev = candles[candles.length - 2]
  const { high: H, low: L, close: C } = prev
  const P  = (H + L + C) / 3
  return {
    P,
    R1: 2 * P - L,
    R2: P + (H - L),
    S1: 2 * P - H,
    S2: P - (H - L),
  }
}

// ── ATR (Average True Range) — Wilder smoothing ─────────────────
export function calculateATR(candles, period = 14) {
  if (!candles || candles.length < period + 1) return null
  const trs = []
  for (let i = 1; i < candles.length; i++) {
    const h = candles[i].high, l = candles[i].low, pc = candles[i - 1].close
    trs.push(Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc)))
  }
  // Wilder smoothing: prima SMA dei primi `period` TR, poi RMA
  let atr = trs.slice(0, period).reduce((a, b) => a + b, 0) / period
  for (let i = period; i < trs.length; i++) {
    atr = (atr * (period - 1) + trs[i]) / period
  }
  return atr  // numero singolo (ultimo valore ATR)
}

// ── Overall Signal ────────────────────────────────────────────────
export function calculateSignal(candles) {
  if (!candles || candles.length < 50) return null

  const last = candles[candles.length - 1].close
  const ema20  = calculateEMA(candles, 20)
  const ema50  = calculateEMA(candles, 50)
  const ema200 = calculateEMA(candles, 200)
  const rsi    = calculateRSI(candles)
  const macd   = calculateMACD(candles)
  const bb     = calculateBB(candles)

  const v20  = ema20[ema20.length - 1]?.value
  const v50  = ema50[ema50.length - 1]?.value
  const v200 = ema200[ema200.length - 1]?.value

  let score = 0

  if (v200 && last > v200) score += 1.5; else score -= 1.5
  if (v20 && v50 && v20 > v50) score += 1; else score -= 1
  if (v20 && last > v20) score += 0.5; else score -= 0.5

  if (rsi) {
    if (rsi.value < 30) score += 1.5
    else if (rsi.value > 70) score -= 1.5
    else if (rsi.value > 50) score += 0.5
    else score -= 0.5
  }

  if (macd) {
    score += macd.histogram > 0 ? 1 : -1
    score += macd.momentum === 'CRESCENTE' ? 0.5 : -0.5
  }

  if (bb) {
    if (bb.pos < 0.15) score += 0.5
    else if (bb.pos > 0.85) score -= 0.5
  }

  const maxScore = 6.5
  const strength = Math.min(Math.abs(score) / maxScore, 1)

  let label, color, bars
  if (score >= 3.5)      { label = 'COMPRA FORTE'; color = '#00e096'; bars = 5 }
  else if (score >= 1.5) { label = 'COMPRA';       color = '#00b377'; bars = 4 }
  else if (score >= -1.5){ label = 'NEUTRO';        color = '#f5c842'; bars = 3 }
  else if (score >= -3.5){ label = 'VENDI';         color = '#ff7755'; bars = 2 }
  else                   { label = 'VENDI FORTE';   color = '#ff3355'; bars = 1 }

  return {
    label, color, score, strength, bars,
    ema: { v20, v50, v200 },
    rsi, macd, bb,
  }
}
