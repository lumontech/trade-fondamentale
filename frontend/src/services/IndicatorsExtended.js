// IndicatorsExtended — set completo di indicatori tecnici professionali
// Selezionati tra i più affidabili per forex/oro/indici secondo letteratura
// (Murphy, Pring, Nison, accademici sui maggiori).

// ═══════════════════════════════════════════════════════════════
// FIBONACCI RETRACEMENT & EXTENSION
// ═══════════════════════════════════════════════════════════════
const FIB_RETRACE = [0, 0.236, 0.382, 0.5, 0.618, 0.786, 1.0]
const FIB_EXTEND  = [1.272, 1.414, 1.618, 2.0, 2.618]

export function calculateFibonacci(candles, lookback = 120) {
  if (!candles || candles.length < 30) return null
  const slice = candles.slice(-lookback)
  let highIdx = 0, lowIdx = 0
  for (let i = 0; i < slice.length; i++) {
    if (slice[i].high > slice[highIdx].high) highIdx = i
    if (slice[i].low  < slice[lowIdx].low)   lowIdx = i
  }
  const high = slice[highIdx].high
  const low  = slice[lowIdx].low
  if (high === low) return null
  const range = high - low
  const trend = highIdx > lowIdx ? 'up' : 'down'
  const currentPrice = slice[slice.length - 1].close

  // Retracement levels
  const retracement = trend === 'up'
    ? FIB_RETRACE.map(r => ({ ratio: r, price: high - range * r, label: `${(r * 100).toFixed(1)}%` }))
    : FIB_RETRACE.map(r => ({ ratio: r, price: low + range * r,  label: `${(r * 100).toFixed(1)}%` }))

  // Extension (target proiezioni)
  const extension = trend === 'up'
    ? FIB_EXTEND.map(r => ({ ratio: r, price: low + range * r, label: `${(r * 100).toFixed(1)}%` }))
    : FIB_EXTEND.map(r => ({ ratio: r, price: high - range * r, label: `${(r * 100).toFixed(1)}%` }))

  // Quale livello è più vicino al prezzo attuale
  const closest = retracement.reduce((best, l) =>
    Math.abs(l.price - currentPrice) < Math.abs(best.price - currentPrice) ? l : best, retracement[0])

  return {
    trend, high, low, range, currentPrice,
    retracement, extension,
    closest_level: closest,
    distance_to_618: ((retracement.find(l => l.ratio === 0.618).price - currentPrice) / currentPrice) * 100,
  }
}

// ═══════════════════════════════════════════════════════════════
// STOCHASTIC OSCILLATOR (%K, %D)
// ═══════════════════════════════════════════════════════════════
export function calculateStochastic(candles, period = 14, kSmooth = 3, dPeriod = 3) {
  if (candles.length < period + dPeriod) return null
  const kRaw = []
  for (let i = period - 1; i < candles.length; i++) {
    const slice = candles.slice(i - period + 1, i + 1)
    const high = Math.max(...slice.map(c => c.high))
    const low  = Math.min(...slice.map(c => c.low))
    const close = candles[i].close
    if (high === low) { kRaw.push(50); continue }
    kRaw.push(((close - low) / (high - low)) * 100)
  }
  // Smooth K
  const k = []
  for (let i = kSmooth - 1; i < kRaw.length; i++) {
    k.push(kRaw.slice(i - kSmooth + 1, i + 1).reduce((s, x) => s + x, 0) / kSmooth)
  }
  // D = SMA of K
  const d = []
  for (let i = dPeriod - 1; i < k.length; i++) {
    d.push(k.slice(i - dPeriod + 1, i + 1).reduce((s, x) => s + x, 0) / dPeriod)
  }
  const lastK = k[k.length - 1]
  const lastD = d[d.length - 1]
  return {
    k: Math.round(lastK * 10) / 10,
    d: Math.round(lastD * 10) / 10,
    state: lastK > 80 ? 'overbought' : lastK < 20 ? 'oversold' : 'neutral',
    cross: k.length >= 2 && d.length >= 2
      ? (k[k.length - 2] < d[d.length - 2] && lastK > lastD ? 'bullish'
         : k[k.length - 2] > d[d.length - 2] && lastK < lastD ? 'bearish'
         : null)
      : null,
  }
}

// ═══════════════════════════════════════════════════════════════
// STOCH RSI (RSI di Stochastic, più sensibile)
// ═══════════════════════════════════════════════════════════════
export function calculateStochRSI(candles, period = 14) {
  if (candles.length < period * 2 + 1) return null
  // Prima calcola RSI
  const closes = candles.map(c => c.close)
  const gains = [], losses = []
  for (let i = 1; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1]
    gains.push(diff > 0 ? diff : 0)
    losses.push(diff < 0 ? -diff : 0)
  }
  let avgG = gains.slice(0, period).reduce((s, x) => s + x, 0) / period
  let avgL = losses.slice(0, period).reduce((s, x) => s + x, 0) / period
  const rsiSeries = []
  for (let i = period; i < gains.length; i++) {
    avgG = (avgG * (period - 1) + gains[i]) / period
    avgL = (avgL * (period - 1) + losses[i]) / period
    const rs = avgL === 0 ? 100 : avgG / avgL
    rsiSeries.push(100 - 100 / (1 + rs))
  }
  if (rsiSeries.length < period) return null
  // Stochastic on RSI
  const recentRSI = rsiSeries.slice(-period)
  const high = Math.max(...recentRSI)
  const low  = Math.min(...recentRSI)
  const last = rsiSeries[rsiSeries.length - 1]
  const stochRSI = high === low ? 50 : ((last - low) / (high - low)) * 100
  return {
    value: Math.round(stochRSI * 10) / 10,
    state: stochRSI > 80 ? 'overbought' : stochRSI < 20 ? 'oversold' : 'neutral',
  }
}

// ═══════════════════════════════════════════════════════════════
// ICHIMOKU CLOUD
// ═══════════════════════════════════════════════════════════════
export function calculateIchimoku(candles) {
  if (candles.length < 52) return null
  const get = (slice) => ({
    high: Math.max(...slice.map(c => c.high)),
    low:  Math.min(...slice.map(c => c.low)),
  })
  const last = candles[candles.length - 1]
  // Tenkan-sen (Conversion Line): (9-high + 9-low) / 2
  const t9 = get(candles.slice(-9))
  const tenkan = (t9.high + t9.low) / 2
  // Kijun-sen (Base Line): (26-high + 26-low) / 2
  const t26 = get(candles.slice(-26))
  const kijun = (t26.high + t26.low) / 2
  // Senkou Span A: (Tenkan + Kijun) / 2 — proiettato 26 avanti
  const senkouA = (tenkan + kijun) / 2
  // Senkou Span B: (52-high + 52-low) / 2 — proiettato 26 avanti
  const t52 = get(candles.slice(-52))
  const senkouB = (t52.high + t52.low) / 2
  // Chikou Span: close shiftato 26 indietro
  const chikou = last.close

  const cloudTop = Math.max(senkouA, senkouB)
  const cloudBot = Math.min(senkouA, senkouB)
  const price = last.close
  let signal
  if (price > cloudTop && tenkan > kijun)        signal = 'strong-bullish'
  else if (price > cloudTop)                     signal = 'bullish'
  else if (price < cloudBot && tenkan < kijun)   signal = 'strong-bearish'
  else if (price < cloudBot)                     signal = 'bearish'
  else                                            signal = 'in-cloud'   // neutro/transition

  return {
    tenkan: round5(tenkan), kijun: round5(kijun),
    senkouA: round5(senkouA), senkouB: round5(senkouB),
    chikou: round5(chikou),
    cloud_top: round5(cloudTop), cloud_bottom: round5(cloudBot),
    signal,
    price_vs_cloud: price > cloudTop ? 'above' : price < cloudBot ? 'below' : 'inside',
    tenkan_kijun_cross: tenkan > kijun ? 'bullish' : tenkan < kijun ? 'bearish' : 'neutral',
  }
}

// ═══════════════════════════════════════════════════════════════
// SUPERTREND
// ═══════════════════════════════════════════════════════════════
export function calculateSupertrend(candles, period = 10, multiplier = 3) {
  if (candles.length < period + 2) return null
  // ATR
  const trs = []
  for (let i = 1; i < candles.length; i++) {
    const c = candles[i], p = candles[i - 1]
    trs.push(Math.max(c.high - c.low, Math.abs(c.high - p.close), Math.abs(c.low - p.close)))
  }
  let atr = trs.slice(0, period).reduce((s, x) => s + x, 0) / period
  const atrSeries = [atr]
  for (let i = period; i < trs.length; i++) {
    atr = (atr * (period - 1) + trs[i]) / period
    atrSeries.push(atr)
  }
  // Supertrend computation
  let supertrend = 0
  let direction = 1   // 1 = uptrend (price above ST), -1 = downtrend
  let prevUpper = 0, prevLower = 0
  for (let i = period; i < candles.length; i++) {
    const c = candles[i]
    const a = atrSeries[i - period]
    const hl2 = (c.high + c.low) / 2
    const upperBand = hl2 + multiplier * a
    const lowerBand = hl2 - multiplier * a
    const finalUpper = upperBand < prevUpper || candles[i - 1].close > prevUpper ? upperBand : prevUpper
    const finalLower = lowerBand > prevLower || candles[i - 1].close < prevLower ? lowerBand : prevLower
    if (i === period) {
      supertrend = finalUpper
      direction = c.close > supertrend ? 1 : -1
    } else if (direction === 1) {
      supertrend = c.close < finalLower ? finalUpper : finalLower
      if (c.close < supertrend) direction = -1
    } else {
      supertrend = c.close > finalUpper ? finalLower : finalUpper
      if (c.close > supertrend) direction = 1
    }
    prevUpper = finalUpper
    prevLower = finalLower
  }
  const last = candles[candles.length - 1]
  return {
    value: round5(supertrend),
    direction: direction > 0 ? 'bullish' : 'bearish',
    distance_pct: round2(((last.close - supertrend) / last.close) * 100),
  }
}

// ═══════════════════════════════════════════════════════════════
// PARABOLIC SAR
// ═══════════════════════════════════════════════════════════════
export function calculatePSAR(candles, accel = 0.02, max = 0.2) {
  if (candles.length < 5) return null
  let sar = candles[0].low
  let ep = candles[0].high
  let af = accel
  let trend = 1   // up
  for (let i = 1; i < candles.length; i++) {
    const c = candles[i]
    sar = sar + af * (ep - sar)
    if (trend === 1) {
      if (c.low < sar) {
        trend = -1
        sar = ep
        ep = c.low
        af = accel
      } else {
        if (c.high > ep) { ep = c.high; af = Math.min(af + accel, max) }
      }
    } else {
      if (c.high > sar) {
        trend = 1
        sar = ep
        ep = c.high
        af = accel
      } else {
        if (c.low < ep) { ep = c.low; af = Math.min(af + accel, max) }
      }
    }
  }
  return {
    value: round5(sar),
    direction: trend > 0 ? 'bullish' : 'bearish',
    above_below: trend > 0 ? 'below price (bullish trend)' : 'above price (bearish trend)',
  }
}

// ═══════════════════════════════════════════════════════════════
// CCI — Commodity Channel Index
// ═══════════════════════════════════════════════════════════════
export function calculateCCI(candles, period = 20) {
  if (candles.length < period) return null
  const slice = candles.slice(-period)
  const tp = slice.map(c => (c.high + c.low + c.close) / 3)
  const sma = tp.reduce((s, x) => s + x, 0) / period
  const meanDev = tp.reduce((s, x) => s + Math.abs(x - sma), 0) / period
  if (meanDev === 0) return null
  const lastTP = (slice[period - 1].high + slice[period - 1].low + slice[period - 1].close) / 3
  const cci = (lastTP - sma) / (0.015 * meanDev)
  return {
    value: Math.round(cci * 10) / 10,
    state: cci > 100 ? 'overbought' : cci < -100 ? 'oversold' : 'neutral',
  }
}

// ═══════════════════════════════════════════════════════════════
// WILLIAMS %R
// ═══════════════════════════════════════════════════════════════
export function calculateWilliamsR(candles, period = 14) {
  if (candles.length < period) return null
  const slice = candles.slice(-period)
  const high = Math.max(...slice.map(c => c.high))
  const low  = Math.min(...slice.map(c => c.low))
  const close = candles[candles.length - 1].close
  if (high === low) return null
  const wr = ((high - close) / (high - low)) * -100
  return {
    value: Math.round(wr * 10) / 10,
    state: wr > -20 ? 'overbought' : wr < -80 ? 'oversold' : 'neutral',
  }
}

// ═══════════════════════════════════════════════════════════════
// AWESOME OSCILLATOR (Bill Williams)
// ═══════════════════════════════════════════════════════════════
export function calculateAO(candles) {
  if (candles.length < 35) return null
  const median = candles.map(c => (c.high + c.low) / 2)
  const sma = (arr, n) => arr.slice(-n).reduce((s, x) => s + x, 0) / n
  const ao = sma(median, 5) - sma(median, 34)
  // Direzione: confronto con AO precedente
  const prevMedian = candles.slice(0, -1).map(c => (c.high + c.low) / 2)
  const prevAO = sma(prevMedian, 5) - sma(prevMedian, 34)
  return {
    value: round5(ao),
    momentum: ao > prevAO ? 'increasing' : 'decreasing',
    state: ao > 0 ? 'bullish' : 'bearish',
  }
}

// ═══════════════════════════════════════════════════════════════
// OBV (On Balance Volume)
// ═══════════════════════════════════════════════════════════════
export function calculateOBV(candles) {
  if (candles.length < 20) return null
  let obv = 0
  const series = [0]
  for (let i = 1; i < candles.length; i++) {
    if (candles[i].close > candles[i - 1].close) obv += candles[i].volume || 0
    else if (candles[i].close < candles[i - 1].close) obv -= candles[i].volume || 0
    series.push(obv)
  }
  // Trend OBV (slope ultime 20 candele)
  const recent = series.slice(-20)
  const slope = (recent[recent.length - 1] - recent[0]) / recent.length
  return {
    value: Math.round(obv),
    trend: slope > 0 ? 'accumulation' : slope < 0 ? 'distribution' : 'neutral',
    slope: Math.round(slope),
  }
}

// ═══════════════════════════════════════════════════════════════
// MFI — Money Flow Index (volume-weighted RSI)
// ═══════════════════════════════════════════════════════════════
export function calculateMFI(candles, period = 14) {
  if (candles.length < period + 1) return null
  let posFlow = 0, negFlow = 0
  for (let i = candles.length - period; i < candles.length; i++) {
    const c = candles[i], p = candles[i - 1]
    const tp  = (c.high + c.low + c.close) / 3
    const ptp = (p.high + p.low + p.close) / 3
    const flow = tp * (c.volume || 0)
    if (tp > ptp) posFlow += flow
    else if (tp < ptp) negFlow += flow
  }
  if (negFlow === 0) return { value: 100, state: 'extreme-bullish' }
  const mfRatio = posFlow / negFlow
  const mfi = 100 - 100 / (1 + mfRatio)
  return {
    value: Math.round(mfi * 10) / 10,
    state: mfi > 80 ? 'overbought' : mfi < 20 ? 'oversold' : 'neutral',
  }
}

// ═══════════════════════════════════════════════════════════════
// VWAP — Volume Weighted Average Price (rolling)
// ═══════════════════════════════════════════════════════════════
export function calculateVWAP(candles, period = 20) {
  if (candles.length < period) return null
  const slice = candles.slice(-period)
  let cumPV = 0, cumV = 0
  for (const c of slice) {
    const tp = (c.high + c.low + c.close) / 3
    const v = c.volume || 0
    cumPV += tp * v
    cumV += v
  }
  if (cumV === 0) return null
  const vwap = cumPV / cumV
  const lastClose = candles[candles.length - 1].close
  return {
    value: round5(vwap),
    price_vs_vwap: lastClose > vwap ? 'above' : lastClose < vwap ? 'below' : 'at',
    distance_pct: round2(((lastClose - vwap) / vwap) * 100),
  }
}

// ═══════════════════════════════════════════════════════════════
// KELTNER CHANNELS (EMA ± mult * ATR)
// ═══════════════════════════════════════════════════════════════
export function calculateKeltner(candles, emaPeriod = 20, atrPeriod = 10, multiplier = 2) {
  if (candles.length < Math.max(emaPeriod, atrPeriod) + 1) return null
  // EMA
  const closes = candles.map(c => c.close)
  let ema = closes.slice(0, emaPeriod).reduce((s, x) => s + x, 0) / emaPeriod
  const k = 2 / (emaPeriod + 1)
  for (let i = emaPeriod; i < closes.length; i++) {
    ema = closes[i] * k + ema * (1 - k)
  }
  // ATR
  const trs = []
  for (let i = 1; i < candles.length; i++) {
    const c = candles[i], p = candles[i - 1]
    trs.push(Math.max(c.high - c.low, Math.abs(c.high - p.close), Math.abs(c.low - p.close)))
  }
  let atr = trs.slice(0, atrPeriod).reduce((s, x) => s + x, 0) / atrPeriod
  for (let i = atrPeriod; i < trs.length; i++) {
    atr = (atr * (atrPeriod - 1) + trs[i]) / atrPeriod
  }
  const upper = ema + multiplier * atr
  const lower = ema - multiplier * atr
  const lastClose = candles[candles.length - 1].close
  return {
    upper: round5(upper),
    middle: round5(ema),
    lower: round5(lower),
    position: lastClose > upper ? 'above' : lastClose < lower ? 'below' : 'inside',
  }
}

// ═══════════════════════════════════════════════════════════════
// DONCHIAN CHANNELS (highest/lowest N period)
// ═══════════════════════════════════════════════════════════════
export function calculateDonchian(candles, period = 20) {
  if (candles.length < period) return null
  const slice = candles.slice(-period)
  const upper = Math.max(...slice.map(c => c.high))
  const lower = Math.min(...slice.map(c => c.low))
  const middle = (upper + lower) / 2
  const last = candles[candles.length - 1]
  return {
    upper: round5(upper),
    middle: round5(middle),
    lower: round5(lower),
    breakout: last.close >= upper ? 'bullish-breakout'
            : last.close <= lower ? 'bearish-breakout'
            : 'inside',
  }
}

// ═══════════════════════════════════════════════════════════════
// LINEAR REGRESSION (slope + R²)
// ═══════════════════════════════════════════════════════════════
export function calculateLinearRegression(candles, period = 50) {
  if (candles.length < period) return null
  const slice = candles.slice(-period).map(c => c.close)
  const n = slice.length
  let sumX = 0, sumY = 0, sumXY = 0, sumX2 = 0, sumY2 = 0
  for (let i = 0; i < n; i++) {
    sumX += i; sumY += slice[i]
    sumXY += i * slice[i]
    sumX2 += i * i
    sumY2 += slice[i] * slice[i]
  }
  const meanX = sumX / n, meanY = sumY / n
  const slope = (sumXY - n * meanX * meanY) / (sumX2 - n * meanX * meanX)
  const intercept = meanY - slope * meanX
  // R² (coefficient of determination)
  const ssTot = sumY2 - n * meanY * meanY
  const ssRes = slice.reduce((s, y, i) => s + Math.pow(y - (slope * i + intercept), 2), 0)
  const rSquared = ssTot === 0 ? 0 : 1 - ssRes / ssTot
  // Trend strength: slope normalizzato sul range
  const range = Math.max(...slice) - Math.min(...slice)
  const slopeNormalized = range > 0 ? (slope * n) / range : 0

  return {
    slope: round5(slope),
    r_squared: Math.round(rSquared * 100) / 100,
    direction: slope > 0 ? 'up' : slope < 0 ? 'down' : 'flat',
    strength: rSquared > 0.7 ? 'strong' : rSquared > 0.4 ? 'medium' : 'weak',
    slope_normalized: Math.round(slopeNormalized * 100) / 100,
  }
}

// ═══════════════════════════════════════════════════════════════
// HEIKIN-ASHI (smoothed candles)
// ═══════════════════════════════════════════════════════════════
export function calculateHeikinAshi(candles, lookback = 5) {
  if (candles.length < lookback + 1) return null
  // Compute HA delle ultime lookback candele
  let haOpen = (candles[0].open + candles[0].close) / 2
  let haClose
  let lastHA = null
  const series = []
  for (const c of candles) {
    haClose = (c.open + c.high + c.low + c.close) / 4
    haOpen = lastHA ? (lastHA.open + lastHA.close) / 2 : haOpen
    const haHigh = Math.max(c.high, haOpen, haClose)
    const haLow  = Math.min(c.low, haOpen, haClose)
    lastHA = { open: haOpen, high: haHigh, low: haLow, close: haClose }
    series.push(lastHA)
  }
  // Trend HA: ultime N candele bullish/bearish
  const recent = series.slice(-lookback)
  const bullish = recent.filter(c => c.close > c.open).length
  const bearish = recent.length - bullish
  return {
    last: { open: round5(haOpen), close: round5(haClose) },
    trend: bullish === recent.length ? 'strong-bullish'
         : bearish === recent.length ? 'strong-bearish'
         : bullish > bearish ? 'bullish'
         : bearish > bullish ? 'bearish' : 'mixed',
    bullish_count: bullish,
    bearish_count: bearish,
    sample: lookback,
  }
}

// ═══════════════════════════════════════════════════════════════
// Z-SCORE — quanto il prezzo si distanzia dalla media in StdDev
// ═══════════════════════════════════════════════════════════════
export function calculateZScore(candles, period = 50) {
  if (candles.length < period) return null
  const slice = candles.slice(-period).map(c => c.close)
  const mean = slice.reduce((s, x) => s + x, 0) / period
  const variance = slice.reduce((s, x) => s + (x - mean) ** 2, 0) / period
  const std = Math.sqrt(variance)
  if (std === 0) return null
  const z = (slice[slice.length - 1] - mean) / std
  return {
    value: Math.round(z * 100) / 100,
    state: z > 2 ? 'extreme-overbought' : z > 1 ? 'overbought'
         : z < -2 ? 'extreme-oversold' : z < -1 ? 'oversold' : 'neutral',
  }
}

// ═══════════════════════════════════════════════════════════════
// ALL-IN-ONE: tutti gli indicatori in un solo oggetto compatto
// ═══════════════════════════════════════════════════════════════
function round5(n) { return Math.round(n * 100000) / 100000 }
function round2(n) { return Math.round(n * 100) / 100 }

export function calculateAllExtended(candles) {
  if (!candles || candles.length < 50) return null
  return {
    fibonacci:    calculateFibonacci(candles),
    stochastic:   calculateStochastic(candles),
    stoch_rsi:    calculateStochRSI(candles),
    ichimoku:     calculateIchimoku(candles),
    supertrend:   calculateSupertrend(candles),
    psar:         calculatePSAR(candles),
    cci:          calculateCCI(candles),
    williams_r:   calculateWilliamsR(candles),
    awesome_osc:  calculateAO(candles),
    obv:          calculateOBV(candles),
    mfi:          calculateMFI(candles),
    vwap:         calculateVWAP(candles),
    keltner:      calculateKeltner(candles),
    donchian:     calculateDonchian(candles),
    linear_regr:  calculateLinearRegression(candles),
    heikin_ashi:  calculateHeikinAshi(candles),
    z_score:      calculateZScore(candles),
  }
}
