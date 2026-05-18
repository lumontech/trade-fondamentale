// ScalpingLibrary — strategie di scalping (TF basso, SL/TP stretti, alto WR).
// Separata da StrategyLibrary perché parametri, asset target e regole sono diversi.
//
// Asset target: XAUUSD, BTCUSD, EURUSD, EURGBP, EURJPY, GBPUSD, GBPJPY, USDJPY
// TF tipici: 1m, 5m, 15m
// SL: 0.5-1.0× ATR (vs swing 1.5×)
// TP: 1.0-2.0× ATR (vs swing 3×) — R:R 1:1.5-1:2 ma WR target 55-70%

// ── Session detection (UTC) ────────────────────────────────────────
// Sessione FX e overlap. BTC ignora sessioni ma ha cicli di funding (08:00 / 16:00 / 00:00 UTC)
export const SESSIONS = {
  asian:    { start: 0,  end: 8  },   // Tokyo + Sydney
  london:   { start: 8,  end: 16 },
  ny:       { start: 13, end: 21 },
  overlap:  { start: 13, end: 16 },   // London-NY overlap (alta liquidità)
}

export function getSessionAt(timestamp) {
  const d = new Date(timestamp * 1000)
  const h = d.getUTCHours()
  if (h >= 13 && h < 16) return 'overlap'
  if (h >= 8  && h < 13) return 'london'
  if (h >= 16 && h < 21) return 'ny'
  if (h >= 0  && h < 8)  return 'asian'
  return 'late'
}

// True se il bar `i` è nei primi N minuti dopo l'apertura sessione
function isOpeningWindow(candles, i, sessionHourUTC, windowMinutes = 30) {
  const tfSec = candles[i].time - candles[i - 1]?.time
  if (!tfSec) return false
  const d = new Date(candles[i].time * 1000)
  const h = d.getUTCHours()
  const m = d.getUTCMinutes()
  return h === sessionHourUTC && m < windowMinutes
}

// ── Indicators helpers (locali, ottimizzati per loop scalp) ────────
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
  return { upper: mean + mult * std, mid: mean, lower: mean - mult * std, std }
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

function vwap(candles, sessionStartIdx, i) {
  // VWAP cumulativo dalla sessione (sessionStartIdx) al bar i
  let pv = 0, vol = 0
  for (let j = sessionStartIdx; j <= i; j++) {
    const c = candles[j]
    const tp = (c.high + c.low + c.close) / 3
    const v = c.volume || 1
    pv += tp * v
    vol += v
  }
  return vol > 0 ? pv / vol : null
}

// Stochastic (5,3,3) fast scalp version
function stoch(candles, kPeriod, dPeriod, i) {
  if (i < kPeriod + dPeriod - 2) return null
  const kVals = []
  for (let j = i - dPeriod + 1; j <= i; j++) {
    let hi = -Infinity, lo = Infinity
    for (let k = j - kPeriod + 1; k <= j; k++) {
      if (k < 0) continue
      if (candles[k].high > hi) hi = candles[k].high
      if (candles[k].low  < lo) lo = candles[k].low
    }
    const c = candles[j].close
    kVals.push(hi === lo ? 50 : ((c - lo) / (hi - lo)) * 100)
  }
  const k = kVals[kVals.length - 1]
  const d = kVals.reduce((a, b) => a + b, 0) / kVals.length
  return { k, d }
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

// Trova l'inizio della sessione corrente per il bar `i`
function sessionStartIdx(candles, i, sessionStartUTC = 0) {
  const d = new Date(candles[i].time * 1000)
  const sessionStartTs = Math.floor(Date.UTC(
    d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), sessionStartUTC, 0, 0
  ) / 1000)
  for (let j = i; j >= 0; j--) {
    if (candles[j].time < sessionStartTs) return j + 1
  }
  return 0
}

// ── STRATEGIE SCALP ────────────────────────────────────────────────

// 1. EMA 9/21 Pullback Scalp (5m)
// Condizione: trend up se EMA9>EMA21 + price chiude sopra EMA21 dopo touch EMA9
function strat_ema9_21_pullback(candles, i) {
  const e9  = ema(candles, 9,  i),  e21 = ema(candles, 21, i)
  const e9p = ema(candles, 9,  i-1), e21p = ema(candles, 21, i-1)
  if ([e9, e21, e9p, e21p].some(v => v == null)) return null
  const c = candles[i], p = candles[i-1]
  // Long: trend up + pullback su EMA21 + reentry sopra EMA9
  if (e9 > e21 && p.low <= e21 * 1.001 && c.close > e9 && c.close > c.open) {
    return { direction: 'long', reason: 'EMA9/21 pullback long' }
  }
  // Short: trend down
  if (e9 < e21 && p.high >= e21 * 0.999 && c.close < e9 && c.close < c.open) {
    return { direction: 'short', reason: 'EMA9/21 pullback short' }
  }
  return null
}

// 2. VWAP Bounce (5m, 15m) — durante sessione attiva
function strat_vwap_bounce(candles, i) {
  if (i < 30) return null
  const session = getSessionAt(candles[i].time)
  if (session === 'late' || session === 'asian') return null   // VWAP funziona meglio in liquid sessions
  const startIdx = sessionStartIdx(candles, i, session === 'london' ? 8 : 13)
  if (i - startIdx < 5) return null   // serve almeno 5 bar di sessione
  const vw = vwap(candles, startIdx, i - 1)
  if (vw == null) return null
  const c = candles[i], a = atr(candles, 14, i)
  if (!a) return null
  const dist = Math.abs(c.close - vw) / a
  // Long: prev bar tocca VWAP da sopra, current chiude sopra
  if (candles[i-1].low <= vw && c.close > vw && c.close > c.open && dist < 0.5) {
    return { direction: 'long', reason: 'VWAP bounce long' }
  }
  if (candles[i-1].high >= vw && c.close < vw && c.close < c.open && dist < 0.5) {
    return { direction: 'short', reason: 'VWAP bounce short' }
  }
  return null
}

// 3. Bollinger Band Outer Reversal (5m)
function strat_bb_outer_reversal(candles, i) {
  const b = bb(candles, 20, 2, i)
  const r = rsi(candles, 14, i)
  if (!b || r == null) return null
  const c = candles[i]
  // Long: chiude sotto lower BB con RSI<30 → bounce
  if (c.close < b.lower && r < 30) {
    return { direction: 'long', reason: 'BB lower + RSI extreme oversold' }
  }
  if (c.close > b.upper && r > 70) {
    return { direction: 'short', reason: 'BB upper + RSI extreme overbought' }
  }
  return null
}

// 4. Stochastic Oversold/Overbought Cross (5m)
function strat_stoch_cross(candles, i) {
  const s  = stoch(candles, 5, 3, i)
  const sp = stoch(candles, 5, 3, i-1)
  if (!s || !sp) return null
  // Long: %K incrocia %D al rialzo in zona oversold
  if (sp.k < sp.d && s.k > s.d && s.k < 25) {
    return { direction: 'long', reason: 'Stoch %K cross %D from oversold' }
  }
  if (sp.k > sp.d && s.k < s.d && s.k > 75) {
    return { direction: 'short', reason: 'Stoch %K cross %D from overbought' }
  }
  return null
}

// 5. London Open Breakout (15m)
// Asian range high/low rotto entro 30min apertura London
function strat_london_open_breakout(candles, i) {
  const session = getSessionAt(candles[i].time)
  if (session !== 'london' && session !== 'overlap') return null
  if (!isOpeningWindow(candles, i, 8, 60)) return null
  // Asian range = high/low ultime 8 ore Asian (assumendo TF 15m → 32 bar)
  const asianBars = 32
  if (i < asianBars + 4) return null
  const asianHi = highestHigh(candles, asianBars, i - 4)   // -4 per saltare il transition
  const asianLo = lowestLow(candles, asianBars, i - 4)
  const c = candles[i], p = candles[i-1]
  // Breakout up
  if (p.close <= asianHi && c.close > asianHi) {
    return { direction: 'long', reason: 'London open breakout above Asian high' }
  }
  if (p.close >= asianLo && c.close < asianLo) {
    return { direction: 'short', reason: 'London open breakdown below Asian low' }
  }
  return null
}

// 6. Pivot Point Bounce (5m, 15m)
// Calcola pivot daily (P, S1, R1) e cerca rejection su questi livelli
function strat_pivot_bounce(candles, i) {
  if (i < 96) return null   // serve 1 giorno di 15m bar (96)
  // Daily pivot = (H+L+C)/3 del giorno PRECEDENTE
  const dayBars = 96
  const prevDayStart = i - dayBars * 2
  const prevDayEnd   = i - dayBars
  if (prevDayStart < 0) return null
  let h = -Infinity, l = Infinity
  for (let j = prevDayStart; j < prevDayEnd; j++) {
    if (candles[j].high > h) h = candles[j].high
    if (candles[j].low  < l) l = candles[j].low
  }
  const c0 = candles[prevDayEnd - 1].close
  const P = (h + l + c0) / 3
  const R1 = 2 * P - l, S1 = 2 * P - h
  const c = candles[i], p = candles[i-1]
  const a = atr(candles, 14, i)
  if (!a) return null
  // Bounce su S1: prev tocca, current rimbalza
  if (p.low <= S1 + 0.1 * a && c.close > S1 && c.close > c.open) {
    return { direction: 'long', reason: 'Pivot S1 bounce' }
  }
  if (p.low <= P + 0.1 * a && p.low >= P - 0.1 * a && c.close > P && c.close > c.open) {
    return { direction: 'long', reason: 'Pivot P bounce' }
  }
  if (p.high >= R1 - 0.1 * a && c.close < R1 && c.close < c.open) {
    return { direction: 'short', reason: 'Pivot R1 rejection' }
  }
  if (p.high >= P - 0.1 * a && p.high <= P + 0.1 * a && c.close < P && c.close < c.open) {
    return { direction: 'short', reason: 'Pivot P rejection' }
  }
  return null
}

// 7. Liquidity Sweep + Reversal (SMC-style scalp)
function strat_liquidity_sweep(candles, i) {
  if (i < 25) return null
  const hi = highestHigh(candles, 20, i - 1)
  const lo = lowestLow(candles, 20, i - 1)
  const c = candles[i]
  // Sweep low + reversal
  if (c.low < lo && c.close > lo && c.close > c.open) {
    const wickRatio = (Math.min(c.open, c.close) - c.low) / (c.high - c.low + 1e-9)
    if (wickRatio > 0.4) return { direction: 'long', reason: 'Sweep below SSL + bullish reversal' }
  }
  if (c.high > hi && c.close < hi && c.close < c.open) {
    const wickRatio = (c.high - Math.max(c.open, c.close)) / (c.high - c.low + 1e-9)
    if (wickRatio > 0.4) return { direction: 'short', reason: 'Sweep above BSL + bearish reversal' }
  }
  return null
}

// 7b. Failed Breakout (2-bar confirmed) — institutional fakeout
function strat_failed_breakout(candles, i) {
  if (i < 22) return null
  const k = candles[i], prev = candles[i-1]
  const hi = highestHigh(candles, 20, i - 2)
  const lo = lowestLow(candles, 20, i - 2)
  if (hi - lo <= 0) return null
  if (prev.close > hi && k.close < hi && k.close < k.open && k.close < prev.close) {
    if ((prev.close - k.close) / (hi - lo) > 0.1) {
      return { direction: 'short', reason: 'Failed breakout — bull trap' }
    }
  }
  if (prev.close < lo && k.close > lo && k.close > k.open && k.close > prev.close) {
    if ((k.close - prev.close) / (hi - lo) > 0.1) {
      return { direction: 'long', reason: 'Failed breakdown — bear trap' }
    }
  }
  return null
}

// 7c. MSS / ChoCH (SMC) — Market Structure Shift dopo liquidity sweep
// Setup A+ documentato 65-72% WR (ICT, ottimo su BTC e XAU)
function strat_mss_choch(candles, i) {
  if (i < 30) return null
  let lastHigh = -Infinity, lastLow = Infinity
  for (let j = i - 30; j < i - 2; j++) {
    if (candles[j].high > lastHigh) lastHigh = candles[j].high
    if (candles[j].low  < lastLow)  lastLow  = candles[j].low
  }
  const prev = candles[i - 1], k = candles[i]
  if (prev.low < lastLow && prev.close > lastLow &&
      k.close > lastHigh && k.close > k.open) {
    return { direction: 'long', reason: 'SMC sweep + bullish MSS' }
  }
  if (prev.high > lastHigh && prev.close < lastHigh &&
      k.close < lastLow && k.close < k.open) {
    return { direction: 'short', reason: 'SMC sweep + bearish MSS' }
  }
  return null
}

// 7d. Triple Bar Trap — versione ultra conservativa del Failed Breakout
// 3 bar confirmation: WR 65-70% (Brooks)
function strat_triple_bar_trap(candles, i) {
  if (i < 23) return null
  const b1 = candles[i - 2], b2 = candles[i - 1], b3 = candles[i]
  const hi = highestHigh(candles, 20, i - 3)
  const lo = lowestLow(candles, 20, i - 3)
  if (hi - lo <= 0) return null
  if (b1.close > hi && b2.close > hi &&
      b3.close < hi && b3.close < b3.open && b3.close < b2.close) {
    if ((b2.close - b3.close) / (hi - lo) > 0.15) {
      return { direction: 'short', reason: 'Triple bar bull trap' }
    }
  }
  if (b1.close < lo && b2.close < lo &&
      b3.close > lo && b3.close > b3.open && b3.close > b2.close) {
    if ((b3.close - b2.close) / (hi - lo) > 0.15) {
      return { direction: 'long', reason: 'Triple bar bear trap' }
    }
  }
  return null
}

// 7e. Pivot Daily Reversal — failed breakout sui livelli pivot
function strat_pivot_reversal(candles, i) {
  const dayBars = i >= 192 ? 96 : 24
  if (i < dayBars * 2) return null
  let h = -Infinity, l = Infinity
  for (let j = i - dayBars * 2; j < i - dayBars; j++) {
    if (candles[j].high > h) h = candles[j].high
    if (candles[j].low  < l) l = candles[j].low
  }
  const c0 = candles[i - dayBars - 1].close
  const P = (h + l + c0) / 3
  const R1 = 2 * P - l, S1 = 2 * P - h
  const R2 = P + (h - l), S2 = P - (h - l)
  const tol = (h - l) * 0.05
  const k = candles[i], prev = candles[i - 1]
  for (const lvl of [R1, R2]) {
    if (prev.high > lvl + tol && k.close < lvl && k.close < k.open) {
      return { direction: 'short', reason: `Failed breakout pivot R (${lvl.toFixed(2)})` }
    }
  }
  for (const lvl of [S1, S2]) {
    if (prev.low < lvl - tol && k.close > lvl && k.close > k.open) {
      return { direction: 'long', reason: `Failed breakdown pivot S (${lvl.toFixed(2)})` }
    }
  }
  return null
}

// 8. Engulfing + Volume Spike (5m pure PA)
function strat_engulfing_volume(candles, i) {
  if (i < 21) return null
  const c = candles[i], p = candles[i-1]
  // Avg volume ultimi 20 bar
  let vSum = 0
  for (let j = i - 20; j < i; j++) vSum += (candles[j].volume || 0)
  const avgVol = vSum / 20
  const cVol = c.volume || 0
  if (cVol < avgVol * 1.5) return null    // serve volume spike
  // Bullish engulfing
  if (p.close < p.open && c.close > c.open && c.open <= p.close && c.close >= p.open) {
    return { direction: 'long', reason: 'Bullish engulfing + volume spike' }
  }
  if (p.close > p.open && c.close < c.open && c.open >= p.close && c.close <= p.open) {
    return { direction: 'short', reason: 'Bearish engulfing + volume spike' }
  }
  return null
}

// 9. Inside Bar Compression Break (5m, 15m)
function strat_inside_bar_break(candles, i) {
  if (i < 4) return null
  const c = candles[i], m1 = candles[i-1], m2 = candles[i-2]
  const isInside = m1.high < m2.high && m1.low > m2.low
  if (!isInside) return null
  // Compressione: range m1 < 70% range m2
  if ((m1.high - m1.low) > (m2.high - m2.low) * 0.7) return null
  if (c.close > m2.high) return { direction: 'long',  reason: 'Inside bar compression breakout up' }
  if (c.close < m2.low)  return { direction: 'short', reason: 'Inside bar compression breakout down' }
  return null
}

// 10. Three Bar Reversal (Pure PA scalp)
// Bar 1: forte trend, Bar 2: small body opposite, Bar 3: closes through
function strat_three_bar_reversal(candles, i) {
  if (i < 3) return null
  const a = candles[i-2], b = candles[i-1], c = candles[i]
  const aBody = Math.abs(a.close - a.open)
  const bBody = Math.abs(b.close - b.open)
  const cBody = Math.abs(c.close - c.open)
  if (aBody < bBody * 2) return null         // Bar 1 deve essere grande
  // Bullish: A bearish forte, B small, C bullish che chiude > A.open
  if (a.close < a.open && bBody < aBody * 0.5 && c.close > c.open && c.close > a.open) {
    return { direction: 'long', reason: 'Three-bar reversal bullish' }
  }
  if (a.close > a.open && bBody < aBody * 0.5 && c.close < c.open && c.close < a.open) {
    return { direction: 'short', reason: 'Three-bar reversal bearish' }
  }
  return null
}

// 11. Trend Continuation Pullback (Higher High / Higher Low scalp)
function strat_hhhl_continuation(candles, i) {
  if (i < 15) return null
  const e21  = ema(candles, 21, i)
  if (!e21) return null
  const c = candles[i], p = candles[i-1]
  // Long: price > EMA21, prev bar fa lower low, current chiude su retrace
  if (c.close > e21) {
    // Cerca un pullback piccolo (3-5 bar) e bounce
    const pullback = candles.slice(i - 4, i).every(b => b.low > e21 * 0.998)
    if (pullback && p.close < p.open && c.close > p.high) {
      return { direction: 'long', reason: 'Trend pullback + bullish continuation' }
    }
  }
  if (c.close < e21) {
    const pullback = candles.slice(i - 4, i).every(b => b.high < e21 * 1.002)
    if (pullback && p.close > p.open && c.close < p.low) {
      return { direction: 'short', reason: 'Trend pullback + bearish continuation' }
    }
  }
  return null
}

// 12. NY Session Open Fade (15m)
// Spike nei primi 15-30 min dopo apertura NY → fade nella direzione opposta
function strat_ny_open_fade(candles, i) {
  if (!isOpeningWindow(candles, i, 13, 30)) return null
  const c = candles[i], p = candles[i-1]
  const a = atr(candles, 14, i)
  if (!a) return null
  // Spike up senza follow-through → fade short
  if (p.high - p.low > a * 1.5 && p.close < (p.high + p.low) / 2 && c.close < p.close) {
    return { direction: 'short', reason: 'NY open spike up exhaustion' }
  }
  if (p.high - p.low > a * 1.5 && p.close > (p.high + p.low) / 2 && c.close > p.close) {
    return { direction: 'long', reason: 'NY open spike down exhaustion' }
  }
  return null
}

// ── Registry ───────────────────────────────────────────────────────
// Each entry: id, name, icon, style, expectedWR_range, supportedPairs, optimalTimeframes,
//   slMul, tpMul, fn, description
export const SCALPING_STRATEGIES = [
  {
    id: 'ema921', name: 'EMA 9/21 Pullback', icon: '📈', style: 'trend',
    expectedWR: '55-62%', slMul: 0.8, tpMul: 1.5,
    optimalTF: ['5m', '15m'], supportedPairs: 'all',
    desc: 'Trend continuation: pullback su EMA21 con reentry sopra EMA9. Funziona bene in trend forti, fallisce in range.',
    fn: strat_ema9_21_pullback,
  },
  {
    id: 'vwap', name: 'VWAP Bounce', icon: '📊', style: 'mean-reversion',
    expectedWR: '60-67%', slMul: 0.7, tpMul: 1.2,
    optimalTF: ['5m', '15m'], supportedPairs: 'all',
    desc: 'Bounce su VWAP intraday durante London/NY. Migliore su EUR/USD, GBP/USD, oro.',
    fn: strat_vwap_bounce,
  },
  {
    id: 'bbReversal', name: 'BB Outer + RSI Extreme', icon: '∿', style: 'mean-reversion',
    expectedWR: '58-65%', slMul: 0.8, tpMul: 1.4,
    optimalTF: ['5m'], supportedPairs: 'forex+xau',
    desc: 'Touch lower/upper Bollinger Band con RSI estremo. Mean reversion classico.',
    fn: strat_bb_outer_reversal,
  },
  {
    id: 'stoch', name: 'Stochastic Cross', icon: '⤧', style: 'momentum',
    expectedWR: '55-62%', slMul: 0.8, tpMul: 1.3,
    optimalTF: ['5m', '15m'], supportedPairs: 'all',
    desc: 'Cross %K/%D in zona oversold/overbought. Setup classico per piccoli reversal.',
    fn: strat_stoch_cross,
  },
  {
    id: 'londonOpen', name: 'London Open Breakout', icon: '🇬🇧', style: 'breakout',
    expectedWR: '52-60%', slMul: 1.0, tpMul: 2.0,
    optimalTF: ['15m'], supportedPairs: 'forex+xau',
    desc: 'Asian range high/low rotto entro 60min apertura London. Migliore su EUR/USD, GBP/USD, GBP/JPY.',
    fn: strat_london_open_breakout,
  },
  {
    id: 'pivot', name: 'Daily Pivot Bounce', icon: '◇', style: 'mean-reversion',
    expectedWR: '60-68%', slMul: 0.7, tpMul: 1.3,
    optimalTF: ['15m'], supportedPairs: 'all',
    desc: 'Bounce su Pivot/S1/R1 daily. Setup ad alta WR perché istituzionali pricing levels.',
    fn: strat_pivot_bounce,
  },
  {
    id: 'liqSweep', name: 'Liquidity Sweep', icon: '⚡', style: 'smc',
    expectedWR: '62-70%', slMul: 0.8, tpMul: 1.5,
    optimalTF: ['5m', '15m'], supportedPairs: 'all',
    desc: 'Wick spazza il low/high del range, candela chiude dentro range. Scalp SMC ad alta WR.',
    fn: strat_liquidity_sweep,
  },
  {
    id: 'failedBk', name: 'Failed Breakout', icon: '🪤', style: 'reversal',
    expectedWR: '60-68%', slMul: 0.8, tpMul: 1.6,
    optimalTF: ['15m'], supportedPairs: 'all',
    desc: 'Bull/bear trap: bar 1 chiude fuori range, bar 2 torna dentro con close opposto. Setup 2-bar confirmed.',
    fn: strat_failed_breakout,
  },
  {
    id: 'mssChoCHScalp', name: 'MSS / ChoCH (SMC A+)', icon: '🎯', style: 'smc',
    expectedWR: '65-72%', slMul: 0.8, tpMul: 1.8,
    optimalTF: ['15m'], supportedPairs: 'all',
    desc: 'Setup SMC istituzionale: liquidity sweep di un swing + market structure shift sul lato opposto. Il più affidabile dei reversal.',
    fn: strat_mss_choch,
  },
  {
    id: 'tripleBarTrap', name: 'Triple Bar Trap', icon: '🪤🪤', style: 'reversal',
    expectedWR: '65-70%', slMul: 0.9, tpMul: 1.5,
    optimalTF: ['15m'], supportedPairs: 'all',
    desc: '3-bar confirmation: bar 1 break, bar 2 hold (sembra confermato), bar 3 fail. Ultra-conservativo, meno trade ma WR alto.',
    fn: strat_triple_bar_trap,
  },
  {
    id: 'pivotReversal', name: 'Pivot Daily Reversal', icon: '◇', style: 'mean-reversion',
    expectedWR: '62-68%', slMul: 0.7, tpMul: 1.3,
    optimalTF: ['15m'], supportedPairs: 'all',
    desc: 'Failed breakout sui livelli pivot daily (R1/R2/S1/S2): zone istituzionali rispettate. Mark Fisher classic.',
    fn: strat_pivot_reversal,
  },
  {
    id: 'engulfVol', name: 'Engulfing + Volume', icon: '⚔', style: 'pa',
    expectedWR: '55-62%', slMul: 0.9, tpMul: 1.5,
    optimalTF: ['5m', '15m'], supportedPairs: 'btc+xau',
    desc: 'Pattern engulfing classico CON volume spike (>1.5× media). Migliore su BTC/XAU per via del volume reale.',
    fn: strat_engulfing_volume,
  },
  {
    id: 'insideBarComp', name: 'Inside Bar Compression', icon: '⊟', style: 'breakout',
    expectedWR: '55-63%', slMul: 0.8, tpMul: 1.6,
    optimalTF: ['5m', '15m'], supportedPairs: 'all',
    desc: 'Inside bar compresso (<70% range mother bar) breakout. Volatility expansion classica.',
    fn: strat_inside_bar_break,
  },
  {
    id: 'threeBarRev', name: 'Three Bar Reversal', icon: '↻', style: 'pa',
    expectedWR: '52-60%', slMul: 0.9, tpMul: 1.5,
    optimalTF: ['5m', '15m'], supportedPairs: 'all',
    desc: 'Pattern 3-bar reversal: bar grande + bar piccola opposta + bar conferma. Pure price action.',
    fn: strat_three_bar_reversal,
  },
  {
    id: 'hhhl', name: 'HH/HL Continuation', icon: '⤴', style: 'trend',
    expectedWR: '55-62%', slMul: 0.8, tpMul: 1.5,
    optimalTF: ['5m', '15m'], supportedPairs: 'all',
    desc: 'Trend continuation con pullback piccolo (3-4 bar) e ripresa nella direzione del trend.',
    fn: strat_hhhl_continuation,
  },
  {
    id: 'nyOpenFade', name: 'NY Open Spike Fade', icon: '🇺🇸', style: 'reversal',
    expectedWR: '55-63%', slMul: 1.0, tpMul: 1.5,
    optimalTF: ['15m'], supportedPairs: 'forex+xau',
    desc: 'Fade dello spike NY open quando manca follow-through. Trades pochi ma alta probabilità.',
    fn: strat_ny_open_fade,
  },
]

// ── Asset target ───────────────────────────────────────────────────
export const SCALP_PAIRS = [
  { id: 'XAUUSD', label: 'Oro / USD',     category: 'commodity' },
  { id: 'BTCUSD', label: 'Bitcoin / USD', category: 'crypto' },
  { id: 'EURUSD', label: 'EUR / USD',     category: 'forex' },
  { id: 'EURGBP', label: 'EUR / GBP',     category: 'forex' },
  { id: 'EURJPY', label: 'EUR / JPY',     category: 'forex' },
  { id: 'GBPUSD', label: 'GBP / USD',     category: 'forex' },
  { id: 'GBPJPY', label: 'GBP / JPY',     category: 'forex' },
  { id: 'USDJPY', label: 'USD / JPY',     category: 'forex' },
]

// Filtra strategie compatibili con un asset
export function isStrategyCompatibleWithPair(strategy, pairId) {
  const cat = SCALP_PAIRS.find(p => p.id === pairId)?.category
  const sup = strategy.supportedPairs
  if (sup === 'all') return true
  if (sup === 'forex+xau') return cat === 'forex' || pairId === 'XAUUSD'
  if (sup === 'btc+xau')   return pairId === 'BTCUSD' || pairId === 'XAUUSD'
  if (sup === 'forex')     return cat === 'forex'
  return true
}
