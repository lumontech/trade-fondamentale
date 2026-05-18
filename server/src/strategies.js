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

// ATR Wilder smoothed (consistente con Supertrend in IndicatorsExtended.js).
// Seed = simple mean dei primi N TR, poi: ATR_new = [(N-1)*ATR_prev + TR_today] / N
function atrAt(candles, period, i) {
  if (i < period) return null
  // Seed
  let sum = 0
  for (let j = 1; j <= period; j++) {
    const c = candles[j], p = candles[j - 1]
    sum += Math.max(c.high - c.low, Math.abs(c.high - p.close), Math.abs(c.low - p.close))
  }
  let atr = sum / period
  // Wilder smoothing
  for (let j = period + 1; j <= i; j++) {
    const c = candles[j], p = candles[j - 1]
    const tr = Math.max(c.high - c.low, Math.abs(c.high - p.close), Math.abs(c.low - p.close))
    atr = ((period - 1) * atr + tr) / period
  }
  return atr
}

// ── ADX (Average Directional Index) — Wilder 1978 ────────────────────
// Misura la FORZA del trend (non la direzione). Murphy cap. 10.10:
//   ADX > 25 = trend forte (favorire trend-following)
//   ADX < 20 = mercato laterale (favorire mean-reversion)
//   ADX in salita = trend in rinforzo, ADX in discesa = trend in indebolimento
//
// Implementazione Wilder smoothed standard:
//   +DM = max(0, high - prevHigh) se high-prevHigh > prevLow-low altrimenti 0
//   -DM = max(0, prevLow - low) se prevLow-low > high-prevHigh altrimenti 0
//   TR  = true range standard
//   +DI = 100 * Smoothed(+DM) / Smoothed(TR)
//   -DI = 100 * Smoothed(-DM) / Smoothed(TR)
//   DX  = 100 * |+DI - -DI| / (+DI + -DI)
//   ADX = Smoothed(DX) periodo N
function adxAt(candles, period, i) {
  if (i < period * 2) return null
  // Seed: somma primi N TR, +DM, -DM
  let trSum = 0, pdmSum = 0, mdmSum = 0
  for (let j = 1; j <= period; j++) {
    const c = candles[j], p = candles[j - 1]
    const tr = Math.max(c.high - c.low, Math.abs(c.high - p.close), Math.abs(c.low - p.close))
    const upMove = c.high - p.high
    const dnMove = p.low - c.low
    const pdm = (upMove > dnMove && upMove > 0) ? upMove : 0
    const mdm = (dnMove > upMove && dnMove > 0) ? dnMove : 0
    trSum += tr; pdmSum += pdm; mdmSum += mdm
  }
  // Wilder smoothing TR/+DM/-DM
  let trS = trSum, pdmS = pdmSum, mdmS = mdmSum
  const dxArr = []
  for (let j = period + 1; j <= i; j++) {
    const c = candles[j], p = candles[j - 1]
    const tr = Math.max(c.high - c.low, Math.abs(c.high - p.close), Math.abs(c.low - p.close))
    const upMove = c.high - p.high
    const dnMove = p.low - c.low
    const pdm = (upMove > dnMove && upMove > 0) ? upMove : 0
    const mdm = (dnMove > upMove && dnMove > 0) ? dnMove : 0
    trS  = trS  - trS  / period + tr
    pdmS = pdmS - pdmS / period + pdm
    mdmS = mdmS - mdmS / period + mdm
    if (trS <= 0) continue
    const pdi = 100 * pdmS / trS
    const mdi = 100 * mdmS / trS
    const sum = pdi + mdi
    if (sum <= 0) continue
    const dx = 100 * Math.abs(pdi - mdi) / sum
    dxArr.push({ dx, pdi, mdi })
  }
  if (dxArr.length < period) return null
  // ADX = Wilder smoothed DX su periodo N
  let adx = 0
  for (let k = 0; k < period; k++) adx += dxArr[k].dx
  adx /= period
  for (let k = period; k < dxArr.length; k++) {
    adx = (adx * (period - 1) + dxArr[k].dx) / period
  }
  const last = dxArr[dxArr.length - 1]
  return { adx, pdi: last.pdi, mdi: last.mdi }
}

// Volume confirmation helper — Murphy/Bulkowski: ogni breakout valido richiede volume expansion.
// Returns true if:
//   - data disponibile (almeno 10 bar con volume>0 negli ultimi 19) AND volume bar corrente > multiple × media(19)
//   - OPPURE data non disponibile (Yahoo forex, dove tutti i volumi = 0): graceful pass
// Usage in breakout strategies: aggiungere `if (!volumeConfirmed(c, i, 1.5)) return null` prima del return signal.
function volumeConfirmed(candles, i, multiple = 1.5) {
  if (i < 20) return false
  let sum = 0, nonZero = 0
  for (let j = i - 19; j <= i - 1; j++) {
    const v = candles[j].volume || 0
    sum += v
    if (v > 0) nonZero++
  }
  if (nonZero < 10) return true   // data not available → pass-through
  const avg = sum / 19
  return (candles[i].volume || 0) >= multiple * avg
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
  // Murphy cap. 7: breakout senza volume = falso breakout (Bulkowski stats: 60% fail rate)
  if (k.close > hi && volumeConfirmed(c, i, 1.5)) return { direction: 'long',  reason: 'Breakout 20-bar high (vol ✓)' }
  if (k.close < lo && volumeConfirmed(c, i, 1.5)) return { direction: 'short', reason: 'Breakdown 20-bar low (vol ✓)' }
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
  if (m.prevHistogram <= 0 && m.histogram > 0 && price > trend && volumeConfirmed(c, i, 1.3)) {
    return { direction: 'long', reason: 'MACD bullish cross sopra EMA200 (vol ✓)' }
  }
  if (m.prevHistogram >= 0 && m.histogram < 0 && price < trend && volumeConfirmed(c, i, 1.3)) {
    return { direction: 'short', reason: 'MACD bearish cross sotto EMA200 (vol ✓)' }
  }
  return null
}

function strat_insideBar(c, i) {
  if (i < 3) return null
  const k = c[i], m1 = c[i-1], m2 = c[i-2]
  const isInside = m1.high < m2.high && m1.low > m2.low
  if (!isInside) return null
  // Volume filter Murphy
  if (k.close > m2.high && volumeConfirmed(c, i, 1.3)) return { direction: 'long',  reason: 'Inside bar breakout up (vol ✓)' }
  if (k.close < m2.low  && volumeConfirmed(c, i, 1.3)) return { direction: 'short', reason: 'Inside bar breakdown (vol ✓)' }
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

// ── FALSE BREAKOUT (2-bar confirmed) — scalp ────────────────────────
// Bar -1: close FUORI dal range (breakout)
// Bar  0: chiude DENTRO il range con close opposto (reversal)
// Differenza vs Liquidity Sweep: aspetta conferma 2 bar invece di 1 wick
// 60-70% WR storico documentato (Bulkowski "Fakeouts" research)
function strat_failedBreakout(c, i) {
  if (i < 22) return null
  const k    = c[i]      // bar reversal
  const prev = c[i-1]    // bar breakout
  const hi = highestHigh(c, 20, i - 2)
  const lo = lowestLow(c, 20, i - 2)
  if (hi - lo <= 0) return null

  // FAILED HIGH BREAKOUT (bull trap → short)
  if (prev.close > hi && k.close < hi && k.close < k.open && k.close < prev.close) {
    const reentryDepth = (prev.close - k.close) / (hi - lo + 1e-9)
    if (reentryDepth > 0.1) {
      return { direction: 'short', reason: 'Failed breakout sopra resistance — bull trap' }
    }
  }

  // FAILED LOW BREAKDOWN (bear trap → long)
  if (prev.close < lo && k.close > lo && k.close > k.open && k.close > prev.close) {
    const reentryDepth = (k.close - prev.close) / (hi - lo + 1e-9)
    if (reentryDepth > 0.1) {
      return { direction: 'long', reason: 'Failed breakdown sotto support — bear trap' }
    }
  }
  return null
}

// ── MSS / CHOCH SMC — Market Structure Shift after liquidity grab ──
// Setup A+ del SMC institutional. WR documentato 65-72% (ICT, Inner Circle Trader).
// Logica:
//   1. Identifica ultimi swing high (LH) e swing low (LL) negli ultimi 30 bar
//   2. Bar -1 fa sweep: il LOW del bar penetra sotto LL, ma close è sopra LL
//      (= liquidity grab istituzionale)
//   3. Bar 0 fa structure shift: close > ultimo LH (= rottura struttura ribassista)
//   4. Long entry sul close di bar 0
function strat_mssChoCH(c, i) {
  if (i < 30) return null
  // Trova swing high e swing low negli ultimi 30 bar (escludendo i 2 finali)
  let lastHigh = -Infinity, lastHighIdx = -1
  let lastLow  =  Infinity, lastLowIdx  = -1
  for (let j = i - 30; j < i - 2; j++) {
    if (c[j].high > lastHigh) { lastHigh = c[j].high; lastHighIdx = j }
    if (c[j].low  < lastLow)  { lastLow  = c[j].low;  lastLowIdx  = j }
  }
  if (lastHighIdx < 0 || lastLowIdx < 0) return null

  const prev = c[i - 1]   // bar di sweep
  const k    = c[i]       // bar di shift

  // BULL MSS: sweep low + shift sopra last high
  if (prev.low < lastLow && prev.close > lastLow &&
      k.close > lastHigh && k.close > k.open) {
    const shiftStrength = (k.close - lastHigh) / (lastHigh - lastLow + 1e-9)
    if (shiftStrength > 0.05) {
      return { direction: 'long', reason: 'SMC: liquidity sweep + bullish MSS' }
    }
  }

  // BEAR MSS: sweep high + shift sotto last low
  if (prev.high > lastHigh && prev.close < lastHigh &&
      k.close < lastLow && k.close < k.open) {
    const shiftStrength = (lastLow - k.close) / (lastHigh - lastLow + 1e-9)
    if (shiftStrength > 0.05) {
      return { direction: 'short', reason: 'SMC: liquidity sweep + bearish MSS' }
    }
  }
  return null
}

// ── TRIPLE BAR TRAP — versione conservativa del Failed Breakout ─────
// Bar 1: breakout (close fuori range 20-bar)
// Bar 2: hold (close ancora fuori — sembra confermato)
// Bar 3: fail (close DENTRO range, opposite direction)
// Aspetta 3 bar = meno trade ma WR ~70% (Al Brooks, Carter)
function strat_tripleBarTrap(c, i) {
  if (i < 23) return null
  const b1 = c[i - 2]  // breakout
  const b2 = c[i - 1]  // hold
  const b3 = c[i]      // fail
  const hi = highestHigh(c, 20, i - 3)
  const lo = lowestLow(c, 20, i - 3)
  if (hi - lo <= 0) return null

  // BULL TRAP: 2 bar fuori sopra hi, terzo bar fail back inside
  if (b1.close > hi && b2.close > hi &&
      b3.close < hi && b3.close < b3.open && b3.close < b2.close) {
    const reversalDepth = (b2.close - b3.close) / (hi - lo + 1e-9)
    if (reversalDepth > 0.15) {
      return { direction: 'short', reason: 'Triple bar bull trap (2 bar fuori + reversal)' }
    }
  }

  // BEAR TRAP
  if (b1.close < lo && b2.close < lo &&
      b3.close > lo && b3.close > b3.open && b3.close > b2.close) {
    const reversalDepth = (b3.close - b2.close) / (hi - lo + 1e-9)
    if (reversalDepth > 0.15) {
      return { direction: 'long', reason: 'Triple bar bear trap (2 bar fuori + reversal)' }
    }
  }
  return null
}

// ── PIVOT DAILY REVERSAL — failed breakout sui livelli pivot ────────
// Pivot daily = (H+L+C)/3 del giorno precedente
// R1 = 2P - L, R2 = P + (H-L), S1 = 2P - H, S2 = P - (H-L)
// Setup: bar fa wick oltre il livello + close dentro = reversal verso pivot
// WR documentato: 62-68% (Mark Fisher, "The Logical Trader")
function strat_pivotReversal(c, i) {
  // Per TF 15m: 1 giorno = 96 bar; per TF 4h: 1 giorno = 6 bar
  // Heuristic: usa ultime 96 bar se ce ne sono, altrimenti 24 (≈1 giorno 1h)
  const dayBars = i >= 192 ? 96 : 24
  if (i < dayBars * 2) return null
  const prevDayStart = i - dayBars * 2
  const prevDayEnd   = i - dayBars
  let h = -Infinity, l = Infinity
  for (let j = prevDayStart; j < prevDayEnd; j++) {
    if (c[j].high > h) h = c[j].high
    if (c[j].low  < l) l = c[j].low
  }
  const c0 = c[prevDayEnd - 1].close
  const P  = (h + l + c0) / 3
  const R1 = 2 * P - l
  const S1 = 2 * P - h
  const R2 = P + (h - l)
  const S2 = P - (h - l)
  const tolerance = (h - l) * 0.05

  const k = c[i], prev = c[i - 1]
  // FAILED BREAKOUT R1/R2: wick sopra livello, close sotto
  for (const lvl of [R1, R2]) {
    if (prev.high > lvl + tolerance && k.close < lvl && k.close < k.open) {
      return { direction: 'short', reason: `Failed breakout sopra pivot R (${lvl.toFixed(2)})` }
    }
  }
  // FAILED BREAKDOWN S1/S2: wick sotto livello, close sopra
  for (const lvl of [S1, S2]) {
    if (prev.low < lvl - tolerance && k.close > lvl && k.close > k.open) {
      return { direction: 'long', reason: `Failed breakdown sotto pivot S (${lvl.toFixed(2)})` }
    }
  }
  return null
}

// ── DIVERGENCE DETECTION (Wilder/Murphy cap. 10.5.1, 10.11) ────────
// Identifica divergenze regolari prezzo vs oscillatore tra gli ultimi 2 swing locali.
// Murphy: "Wilder considera le divergenze come la caratteristica più indicativa di RSI".
//
// Returns: null | { type: 'bullish'|'bearish', priceLow1/2, oscLow1/2, idx1, idx2 }
// Swing definition: bar j è swing low se candles[j].low < candles[j-2].low E < candles[j+2].low
// (lookback fisso 2 bar per side — equivalente a un pivot 5-bar)
function detectDivergence(candles, oscillatorFn, i, lookback = 30, oscPeriod = 14) {
  if (i < lookback + 5) return null
  // Costruisci serie oscillatore per gli ultimi `lookback` bar (cache-friendly)
  const osc = new Array(lookback)
  for (let k = 0; k < lookback; k++) {
    const idx = i - (lookback - 1) + k
    osc[k] = oscillatorFn(candles, oscPeriod, idx)
  }
  // Trova gli ultimi 2 swing low/high price
  const swingLows = []
  const swingHighs = []
  for (let k = 2; k < lookback - 2; k++) {
    const idx = i - (lookback - 1) + k
    const bar = candles[idx]
    const p2 = candles[idx - 2], p1 = candles[idx - 1]
    const n1 = candles[idx + 1], n2 = candles[idx + 2]
    if (bar.low < p2.low && bar.low < p1.low && bar.low < n1.low && bar.low < n2.low) {
      swingLows.push({ idx, kIdx: k, price: bar.low, osc: osc[k] })
    }
    if (bar.high > p2.high && bar.high > p1.high && bar.high > n1.high && bar.high > n2.high) {
      swingHighs.push({ idx, kIdx: k, price: bar.high, osc: osc[k] })
    }
  }
  // Bullish divergence: price LL + oscillator HL su ultimi 2 swing low
  if (swingLows.length >= 2) {
    const a = swingLows[swingLows.length - 2]
    const b = swingLows[swingLows.length - 1]
    if (a.osc != null && b.osc != null && b.price < a.price && b.osc > a.osc) {
      return { type: 'bullish', priceLow1: a.price, priceLow2: b.price, oscLow1: a.osc, oscLow2: b.osc, idx1: a.idx, idx2: b.idx }
    }
  }
  // Bearish divergence: price HH + oscillator LH su ultimi 2 swing high
  if (swingHighs.length >= 2) {
    const a = swingHighs[swingHighs.length - 2]
    const b = swingHighs[swingHighs.length - 1]
    if (a.osc != null && b.osc != null && b.price > a.price && b.osc < a.osc) {
      return { type: 'bearish', priceHigh1: a.price, priceHigh2: b.price, oscHigh1: a.osc, oscHigh2: b.osc, idx1: a.idx, idx2: b.idx }
    }
  }
  return null
}

// ── RSI DIVERGENCE strategy (Murphy cap. 10.5 — "feature più indicativa") ────
// Setup A+ Wilder:
//   - Divergenza regolare bullish/bearish tra prezzo e RSI(14)
//   - RSI dell'ultimo swing in zona OB/OS (Murphy: divergenze in zona estrema valgono di più)
//   - Bar corrente conferma con candela direzionale
//   - Idealmente: filtro macro trend (per evitare divergenze contro trend forte)
function strat_rsiDivergence(c, i) {
  if (i < 50) return null
  const div = detectDivergence(c, rsi, i, 30, 14)
  if (!div) return null
  const k = c[i]
  const price = k.close

  // Murphy cap. 10.9: "Non bisogna dare un'importanza eccessiva alla sola analisi delle divergenze,
  // per non finire con l'ignorare l'analisi del trend tradizionale."
  // Filtri aggiuntivi per ridurre falsi positivi:
  //   - Trend macro: NON tradare contro EMA50 forte (anti-cascade)
  //   - RSI in zona estrema più stretta (≤30 / ≥70 invece di 35/65)
  //   - Conferma bar reversale chiara (close > metà range)
  //   - Volatilità minima (ATR > 0.15% del prezzo)
  //   - Sessione attiva (no Asia low-liquidity)
  //   - Divergenza recente (ultimo swing nelle ultime 5 bar)
  const e50 = ema(c, 50, i)
  if (e50 == null) return null
  const distFromE50 = Math.abs(price - e50) / e50
  if (distFromE50 > 0.025) return null   // anti-cascade

  const a = atrAt(c, 14, i)
  if (a == null || a / price < 0.0015) return null

  const session = getSessionAt(k.time)
  if (session === 'asian' || session === 'late') return null

  const barRange = k.high - k.low
  if (barRange <= 0) return null
  const closePosInRange = (k.close - k.low) / barRange

  // Bullish: div + RSI ≤ 30 + bar bullish strong (close in top half) + ultimo swing recente
  if (div.type === 'bullish' && div.oscLow2 <= 30 && k.close > k.open && closePosInRange > 0.55) {
    const swingRecency = i - div.idx2
    if (swingRecency > 5) return null
    return {
      direction: 'long',
      reason: `RSI bullish divergence (price LL, RSI ${div.oscLow1.toFixed(1)}→${div.oscLow2.toFixed(1)} HL, ${swingRecency}b ago)`,
    }
  }
  // Bearish: div + RSI ≥ 70 + bar bearish strong (close in bottom half) + ultimo swing recente
  if (div.type === 'bearish' && div.oscHigh2 >= 70 && k.close < k.open && closePosInRange < 0.45) {
    const swingRecency = i - div.idx2
    if (swingRecency > 5) return null
    return {
      direction: 'short',
      reason: `RSI bearish divergence (price HH, RSI ${div.oscHigh1.toFixed(1)}→${div.oscHigh2.toFixed(1)} LH, ${swingRecency}b ago)`,
    }
  }
  return null
}

// ── SWING POINT DETECTION helper (per pattern recognition) ───────────
// Restituisce ultimi N swing high/low usando confirmation di 2 bar per side.
function findRecentSwings(c, i, lookback = 60, confirmBars = 2) {
  const lows = [], highs = []
  const start = Math.max(confirmBars, i - lookback)
  for (let j = start; j <= i - confirmBars; j++) {
    let isLow = true, isHigh = true
    for (let k = 1; k <= confirmBars; k++) {
      if (c[j].low > c[j - k].low || c[j].low > c[j + k].low) isLow = false
      if (c[j].high < c[j - k].high || c[j].high < c[j + k].high) isHigh = false
    }
    if (isLow) lows.push({ idx: j, price: c[j].low })
    if (isHigh) highs.push({ idx: j, price: c[j].high })
  }
  return { lows, highs }
}

// ── HEAD & SHOULDERS — Murphy cap. 5.3 — pattern di inversione #1 ──
// Top H&S (bearish):
//   1. 3 swing highs: left shoulder (LS) < head (H) > right shoulder (RS)
//   2. Shoulders simili in altezza (entro 1×ATR)
//   3. Neckline = linea che unisce i 2 swing low tra LS-H e H-RS
//   4. Conferma: close < neckline + volume expansion
//   5. Target = (head - neckline) proiettato sotto la rottura
//
// Inverse H&S (bullish): specchiato.
function strat_headShoulders(c, i) {
  if (i < 60) return null
  const k = c[i]
  const a = atrAt(c, 14, i)
  if (a == null) return null

  const swings = findRecentSwings(c, i, 60, 2)
  if (swings.highs.length < 3 || swings.lows.length < 2) return null

  // Top H&S: prendo gli ultimi 3 swing highs
  const h = swings.highs.slice(-3)
  const ls = h[0], head = h[1], rs = h[2]
  // Validazione: head deve essere strettamente il più alto, shoulders simili
  if (head.price > ls.price && head.price > rs.price) {
    const shoulderDiff = Math.abs(ls.price - rs.price)
    if (shoulderDiff < a * 1.0) {
      // Neckline: 2 swing lows tra LS-head e head-RS
      const lowsBetween = swings.lows.filter(l => l.idx > ls.idx && l.idx < rs.idx)
      if (lowsBetween.length >= 1) {
        const neckline = Math.min(...lowsBetween.map(l => l.price))
        // Conferma break: close < neckline + bar bearish + volume
        if (k.close < neckline && k.close < k.open && volumeConfirmed(c, i, 1.3)) {
          // Filtro: shoulder destra deve essere abbastanza recente (entro ultime 10 bar)
          if (i - rs.idx <= 10) {
            return {
              direction: 'short',
              reason: `H&S top: LS ${ls.price.toFixed(4)} / Head ${head.price.toFixed(4)} / RS ${rs.price.toFixed(4)} → neckline ${neckline.toFixed(4)} broken`,
            }
          }
        }
      }
    }
  }

  // Inverse H&S: prendo gli ultimi 3 swing lows
  if (swings.lows.length >= 3 && swings.highs.length >= 2) {
    const l = swings.lows.slice(-3)
    const lsI = l[0], headI = l[1], rsI = l[2]
    if (headI.price < lsI.price && headI.price < rsI.price) {
      const shoulderDiff = Math.abs(lsI.price - rsI.price)
      if (shoulderDiff < a * 1.0) {
        const highsBetween = swings.highs.filter(h => h.idx > lsI.idx && h.idx < rsI.idx)
        if (highsBetween.length >= 1) {
          const neckline = Math.max(...highsBetween.map(h => h.price))
          if (k.close > neckline && k.close > k.open && volumeConfirmed(c, i, 1.3)) {
            if (i - rsI.idx <= 10) {
              return {
                direction: 'long',
                reason: `Inverse H&S: LS ${lsI.price.toFixed(4)} / Head ${headI.price.toFixed(4)} / RS ${rsI.price.toFixed(4)} → neckline ${neckline.toFixed(4)} broken`,
              }
            }
          }
        }
      }
    }
  }

  return null
}

// ── DOUBLE TOP / BOTTOM — Murphy cap. 5.9 — secondo più comune dopo H&S ──
// Top "M": due peaks simili separati da ≥10 bar, valley tra di loro
// Confermato: close sotto la valley + bar bearish + volume
function strat_doubleTopBottom(c, i) {
  if (i < 30) return null
  const k = c[i]
  const a = atrAt(c, 14, i)
  if (a == null) return null

  const swings = findRecentSwings(c, i, 50, 2)

  // Double Top: 2 ultimi swing highs simili
  if (swings.highs.length >= 2 && swings.lows.length >= 1) {
    const recent = swings.highs.slice(-2)
    const [p1, p2] = recent
    const distance = p2.idx - p1.idx
    if (distance >= 10 && distance <= 40) {
      const diff = Math.abs(p1.price - p2.price)
      if (diff < a * 0.8 && i - p2.idx <= 10) {
        const valleysBetween = swings.lows.filter(l => l.idx > p1.idx && l.idx < p2.idx)
        if (valleysBetween.length >= 1) {
          const valley = Math.min(...valleysBetween.map(l => l.price))
          if (k.close < valley && k.close < k.open && volumeConfirmed(c, i, 1.3)) {
            return {
              direction: 'short',
              reason: `Double Top: peaks ${p1.price.toFixed(4)}/${p2.price.toFixed(4)} (${distance}b apart), valley ${valley.toFixed(4)} broken`,
            }
          }
        }
      }
    }
  }

  // Double Bottom: 2 ultimi swing lows simili
  if (swings.lows.length >= 2 && swings.highs.length >= 1) {
    const recent = swings.lows.slice(-2)
    const [t1, t2] = recent
    const distance = t2.idx - t1.idx
    if (distance >= 10 && distance <= 40) {
      const diff = Math.abs(t1.price - t2.price)
      if (diff < a * 0.8 && i - t2.idx <= 10) {
        const peaksBetween = swings.highs.filter(h => h.idx > t1.idx && h.idx < t2.idx)
        if (peaksBetween.length >= 1) {
          const peak = Math.max(...peaksBetween.map(h => h.price))
          if (k.close > peak && k.close > k.open && volumeConfirmed(c, i, 1.3)) {
            return {
              direction: 'long',
              reason: `Double Bottom: troughs ${t1.price.toFixed(4)}/${t2.price.toFixed(4)} (${distance}b apart), peak ${peak.toFixed(4)} broken`,
            }
          }
        }
      }
    }
  }

  return null
}

// ── MACD DIVERGENCE strategy (Murphy cap. 10.11-10.12) ──────────────
function macdHistogramAt(candles, _period, i) {
  const m = macdAt(candles, i)
  return m ? m.histogram : null
}

function strat_macdDivergence(c, i) {
  if (i < 60) return null
  const div = detectDivergence(c, macdHistogramAt, i, 30, 0)
  if (!div) return null
  const k = c[i]
  const price = k.close
  const e50 = ema(c, 50, i)
  if (e50 == null) return null
  if (Math.abs(price - e50) / e50 > 0.025) return null
  const a = atrAt(c, 14, i)
  if (a == null || a / price < 0.0015) return null
  const session = getSessionAt(k.time)
  if (session === 'asian' || session === 'late') return null
  const barRange = k.high - k.low
  if (barRange <= 0) return null
  const closePosInRange = (k.close - k.low) / barRange
  if (div.type === 'bullish' && div.oscLow2 < 0 && k.close > k.open && closePosInRange > 0.55) {
    const r = i - div.idx2
    if (r > 5) return null
    return { direction: 'long', reason: `MACD bullish div: hist ${div.oscLow1.toFixed(5)}->${div.oscLow2.toFixed(5)} (${r}b)` }
  }
  if (div.type === 'bearish' && div.oscHigh2 > 0 && k.close < k.open && closePosInRange < 0.45) {
    const r = i - div.idx2
    if (r > 5) return null
    return { direction: 'short', reason: `MACD bearish div: hist ${div.oscHigh1.toFixed(5)}->${div.oscHigh2.toFixed(5)} (${r}b)` }
  }
  return null
}

// ── CONFLUENCE TRACKER — multi-filter mean-reversion swing 4h ──────
// Strategia DESIGNED da audit dati reali (504 trade DB sim):
//   - 15m TF perde -€1165 vs 4h -€63 → ENTRY SOLO 4h
//   - RSI+BB win 68.4% WR (best esistente) → uso come base
//   - Crypto USDC pair +€157 net vs forex -€892 net → preferenza crypto
//   - WR <40% strategie classiche → CONFLUENCE multi-filter per alzare WR
//
// Regole entry (TUTTE devono essere vere — strict AND):
//   1. RSI(14) sotto 28 (long) o sopra 72 (short) — più stretto del 30/70 classico
//   2. Close fuori Bollinger Band outer (period 20, std 2.5) — non 2.0 standard
//   3. EMA200_4h direzione = direzione trade (no contro-tendenza macro)
//      Approssima il filtro "1D trend" senza richiedere MTF data passthrough.
//   4. Volume bar corrente > 1.5 × mediana(20) — conferma istituzionale
//   5. NO Asian session (low liquidity → spread alto su 4h, raro ma evitabile)
//   6. ATR(14) > 0.2% del prezzo — evita range troppo stretti (no edge)
//
// Exit gestito da sim.js via slMul/tpMul → ATR multiplier:
//   slMul = 1.5  (SL = 1.5 × ATR4h — abbastanza largo per non essere stoppato dalle wick)
//   tpMul = 4.0  (TP = 4.0 × ATR4h — let winners run, R:R atteso 2.67)
//
// Backtest target: WR ≥ 55%, profit factor ≥ 1.8, max DD ≤ 12%.
function strat_confluenceTracker(c, i) {
  if (i < 200) return null

  const k = c[i]
  const price = k.close

  // Filtro 1+2: RSI + BB (standard thresholds)
  const r = rsi(c, 14, i)
  const b = bb(c, 20, 2, i)
  if (r == null || !b) return null

  // Filtro 3: macro trend EMA200_4h (chiave dell'edge — no contro-tendenza)
  const e200 = ema(c, 200, i)
  if (e200 == null) return null

  // Filtro 4: volume confirmation (skip se data source non riporta volumi — es. Yahoo forex)
  let volSum = 0, nonZeroCount = 0
  for (let j = i - 19; j <= i - 1; j++) {
    const v = c[j].volume || 0
    volSum += v
    if (v > 0) nonZeroCount++
  }
  const volumeDataAvailable = nonZeroCount >= 10
  if (volumeDataAvailable) {
    const avgVol = volSum / 19
    if ((k.volume || 0) < 1.3 * avgVol) return null
  }

  // Filtro 5: no Asian/late session
  const session = getSessionAt(k.time)
  if (session === 'asian' || session === 'late') return null

  // Filtro 6: ATR sufficiente (no range market)
  const a = atrAt(c, 14, i)
  if (a == null || a / price < 0.0015) return null  // < 0.15% volatility → skip

  // Regime filter: BB-width (revert da ADX strict che ha azzerato i trade).
  // Empiricamente sui dati 4h, BB-width 1-4% è il regime corretto per mean-reversion.
  // ADX disponibile come `adxAt(c, 14, i)` per altre strategie ma non usato qui.
  const bbWidth = (b.upper - b.lower) / b.mid
  if (bbWidth > 0.04 || bbWidth < 0.01) return null

  // Anti-cascade: se prezzo molto distante da EMA200, è in collasso/parabolic → skip
  const distFromE200 = Math.abs(price - e200) / e200
  if (distFromE200 > 0.025) return null

  // Conferma swing low/high recente: deve esserci un'estremità nella barra corrente o precedente
  // (proxy: la barra corrente è il low/high degli ultimi 5)
  let isLocalLow = true, isLocalHigh = true
  for (let j = i - 4; j < i; j++) {
    if (c[j].low < k.low) isLocalLow = false
    if (c[j].high > k.high) isLocalHigh = false
  }

  // Trend filter Murphy: rimosso il vincolo strict "price > EMA200" perché
  // su mean-reversion crea contraddizione logica (BB lower + uptrend = quasi mai coincidono).
  // Sostituito con anti-cascade: distance from EMA200 limitata a 2.5% (già implementato sopra).
  // BB-width regime filter agisce come ADX proxy (skip se trend > 4% width = troppo forte).

  // LONG: oversold + below BB lower + local low + bullish reversal bar
  if (r < 30 && price < b.lower && isLocalLow && k.close > k.open) {
    return {
      direction: 'long',
      reason: `Confluence LONG: RSI ${r.toFixed(1)} + below BB + local low + reversal bar (BBw ${(bbWidth*100).toFixed(1)}%)`,
    }
  }

  // SHORT: overbought + above BB upper + local high + bearish reversal bar
  if (r > 70 && price > b.upper && isLocalHigh && k.close < k.open) {
    return {
      direction: 'short',
      reason: `Confluence SHORT: RSI ${r.toFixed(1)} + above BB + local high + reversal bar (BBw ${(bbWidth*100).toFixed(1)}%)`,
    }
  }

  return null
}

// ── FALSE BREAKOUT MAJOR — swing 4h, range 50 bar (institutional) ───
// Logica come scalp ma su livelli più profondi (~1 settimana 4h)
// Setup ad alto valore: prende stop-hunt istituzionali
function strat_failedBreakoutMajor(c, i) {
  if (i < 52) return null
  const k    = c[i]
  const prev = c[i-1]
  const hi = highestHigh(c, 50, i - 2)
  const lo = lowestLow(c, 50, i - 2)
  const range = hi - lo
  if (range <= 0) return null

  // Bull trap su livello settimanale
  if (prev.high > hi && prev.close > hi * 1.001 && k.close < hi && k.close < k.open) {
    const reentryDepth = (hi - k.close) / range
    if (reentryDepth > 0.05) {
      return { direction: 'short', reason: 'Failed weekly high — institutional bull trap' }
    }
  }

  // Bear trap su livello settimanale
  if (prev.low < lo && prev.close < lo * 0.999 && k.close > lo && k.close > k.open) {
    const reentryDepth = (k.close - lo) / range
    if (reentryDepth > 0.05) {
      return { direction: 'long', reason: 'Failed weekly low — institutional bear trap' }
    }
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
  { id: 'failedBkMajor', name: 'Failed Breakout Major', category: 'swing', slMul: 1.0, tpMul: 2.5, fn: strat_failedBreakoutMajor },
  { id: 'mssChoCH',      name: 'MSS / ChoCH (SMC A+)',  category: 'swing', slMul: 1.0, tpMul: 2.5, fn: strat_mssChoCH },
  { id: 'tripleBarTrap', name: 'Triple Bar Trap',       category: 'swing', slMul: 1.0, tpMul: 2.0, fn: strat_tripleBarTrap },
  // Confluence Tracker — ATTIVA (backtest 1yr 7 simboli: WR 44.4%, PF 1.99, Sharpe 0.95)
  { id: 'confluenceTracker', name: 'Confluence Tracker (4h)', category: 'swing', slMul: 1.5, tpMul: 4.0, fn: strat_confluenceTracker },
  // RSI Divergence — Murphy cap. 10.5 "feature più indicativa di RSI"
  // Backtest 1yr 7 simboli: WR 40%, PF 1.86, Sharpe 1.08, +5.9%/anno stimato, maxDD 4.2R
  { id: 'rsiDivergence',     name: 'RSI Divergence (Murphy)', category: 'swing', slMul: 1.0, tpMul: 3.0, fn: strat_rsiDivergence },
  // MACD Divergence — Murphy cap. 10.11. Backtest 1yr 7 sym: WR 33.5%, PF 1.40, Sharpe 1.89, +32.8%/anno
  { id: 'macdDivergence',    name: 'MACD Divergence (Murphy)',category: 'swing', slMul: 1.0, tpMul: 3.0, fn: strat_macdDivergence },
  // Head & Shoulders — Murphy cap. 5.3. Backtest: PF 1.01 marginale, OFF in attesa refinement.
  { id: 'headShoulders',     name: 'Head & Shoulders',         category: 'swing', slMul: 1.2, tpMul: 3.0, fn: strat_headShoulders,  enabled: false },
  // Double Top / Bottom — Murphy cap. 5.9. Backtest 1yr 7 sym: WR 45.8%, PF 1.63, Sharpe 1.14, +6.3%/anno
  { id: 'doubleTopBottom',   name: 'Double Top / Bottom',      category: 'swing', slMul: 1.2, tpMul: 2.5, fn: strat_doubleTopBottom },

  // Scalp (TF 5m-15m)
  // Fix #4.1: EMA 9/21 disabilitata (whipsaw frequente, low edge documentato).
  // Marker `enabled: false` -> findStrategy ritorna null -> initAccounts skip.
  { id: 'ema921',         name: 'EMA 9/21 Pullback',     category: 'scalp', slMul: 0.8, tpMul: 1.5, fn: strat_ema921, enabled: false },
  // Scalp R:R aggiornati a >=2:1 per allinearsi a Murphy cap. 18 (min 2:1, optimal 3:1)
  // Trade-off: meno hit rate ma matematicamente sostenibile a 45% WR
  { id: 'vwap',           name: 'VWAP Bounce',           category: 'scalp', slMul: 0.7, tpMul: 1.6, fn: strat_vwap },         // 1.71 → 2.29
  { id: 'bbReversal',     name: 'BB Outer + RSI',        category: 'scalp', slMul: 0.8, tpMul: 1.8, fn: strat_bbReversal },   // 1.75 → 2.25
  { id: 'liqSweep',       name: 'Liquidity Sweep',       category: 'scalp', slMul: 0.8, tpMul: 1.8, fn: strat_liqSweep },     // 1.88 → 2.25
  { id: 'threeBarRev',    name: 'Three Bar Reversal',    category: 'scalp', slMul: 0.9, tpMul: 1.9, fn: strat_threeBarRev }, // 1.67 → 2.11
  { id: 'failedBk',       name: 'Failed Breakout',       category: 'scalp', slMul: 0.8, tpMul: 1.7, fn: strat_failedBreakout },
  { id: 'mssChoCHScalp',  name: 'MSS / ChoCH Scalp',     category: 'scalp', slMul: 0.8, tpMul: 2.0, fn: strat_mssChoCH },     // 1.88 → 2.50
  { id: 'pivotReversal',  name: 'Pivot Daily Reversal',  category: 'scalp', slMul: 0.7, tpMul: 1.5, fn: strat_pivotReversal },// 1.86 → 2.14
]

export function findStrategy(id) {
  const s = STRATEGIES.find(x => x.id === id)
  // Fix #4.1: filter strategie disabilitate (es. ema921). Se enabled === false
  // ritorna null -> processAccount + initAccounts skip in modo backward compat.
  if (!s || s.enabled === false) return null
  return s
}

// Helper esposti per il sim
export { atrAt }
