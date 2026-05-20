// DynamicBacktest.js — Backtest setup-specifico in-browser
//
// SCOPO: invece di un backtest generico ("WR storica su questo asset"),
// calcoliamo il WR REALE di N setup pre-definiti sulle ULTIME candele
// dell'asset attivo. Claude lo riceve in `setup_specific_backtests` e
// può usarlo come filtro: se vede setup tipo "RSI oversold rebound" e
// quello stesso setup ha WR 32% sull'ultima settimana, REGOLA confidence
// verso il basso o passa a FLAT.
//
// Tutto in-browser (no backend), no rete, ~50-200ms per asset.
//
// USE:
//   import { runAllSetupBacktests } from './DynamicBacktest'
//   const stats = runAllSetupBacktests(candles)
//   // → { setups: { rsi_oversold_bounce: {win_rate: 45, ...}, ... }, evaluated_at: ... }

import { calculateRSI, calculateMACD, calculateBB, calculateATR, calculateEMA } from '../utils/indicators'

// ── Helper: RSI inline veloce (non array, single value) ────────────
function rsiAt(candles, idx, period = 14) {
  if (idx < period) return null
  const slice = candles.slice(Math.max(0, idx - period * 3), idx + 1)
  const r = calculateRSI(slice, period)
  return r?.value ?? null
}

// ── Helper: ATR inline (single value to idx) ───────────────────────
function atrAt(candles, idx, period = 14) {
  if (idx < period + 1) return null
  const slice = candles.slice(Math.max(0, idx - period * 3), idx + 1)
  return calculateATR(slice, period)
}

// ── Helper: EMA value at idx ───────────────────────────────────────
function emaAt(candles, idx, period) {
  if (idx < period) return null
  const slice = candles.slice(0, idx + 1)
  const series = calculateEMA(slice, period)
  if (!Array.isArray(series) || series.length === 0) return null
  return series[series.length - 1].value
}

// ── Helper: MACD line/signal at idx ────────────────────────────────
function macdAt(candles, idx) {
  if (idx < 35) return null
  const slice = candles.slice(0, idx + 1)
  return calculateMACD(slice)   // { macd, signal, histogram }
}

// ── Helper: BB position at idx (0=lower, 1=upper) ──────────────────
function bbAt(candles, idx, period = 20, mult = 2) {
  if (idx < period) return null
  const slice = candles.slice(0, idx + 1)
  return calculateBB(slice, period, mult)
}

// ── Helper: bullish/bearish reversal candle? ───────────────────────
function isBullishReversal(candles, idx) {
  if (idx < 1) return false
  const cur = candles[idx], prev = candles[idx - 1]
  if (!cur || !prev) return false
  const curBody = Math.abs(cur.close - cur.open)
  const curRange = cur.high - cur.low
  if (curRange === 0) return false
  // Bullish engulfing
  if (prev.close < prev.open && cur.close > cur.open && cur.close > prev.open && cur.open < prev.close) return true
  // Hammer (long lower wick, small body)
  const lowerWick = Math.min(cur.open, cur.close) - cur.low
  if (lowerWick > 2 * curBody && curBody / curRange < 0.4 && cur.close > cur.open) return true
  return false
}
function isBearishReversal(candles, idx) {
  if (idx < 1) return false
  const cur = candles[idx], prev = candles[idx - 1]
  if (!cur || !prev) return false
  const curBody = Math.abs(cur.close - cur.open)
  const curRange = cur.high - cur.low
  if (curRange === 0) return false
  // Bearish engulfing
  if (prev.close > prev.open && cur.close < cur.open && cur.open > prev.close && cur.close < prev.open) return true
  // Shooting star (long upper wick)
  const upperWick = cur.high - Math.max(cur.open, cur.close)
  if (upperWick > 2 * curBody && curBody / curRange < 0.4 && cur.close < cur.open) return true
  return false
}

// ── Setup Library ──────────────────────────────────────────────────
// Ogni setup ha:
//   - entry(idx, candles): bool — la candela idx attiva l'entry?
//   - direction: 'LONG' | 'SHORT'
//   - sl_atr: SL distance in ATR units
//   - tp_atr: TP distance in ATR units (R = tp_atr/sl_atr)
//   - max_bars: massima durata trade (poi expired)
//   - label: nome display
//   - category: 'momentum' | 'reversal' | 'trend' | 'volatility' | 'pattern'
export const SETUP_LIBRARY = {
  rsi_oversold_bounce: {
    label: 'RSI Oversold Bounce',
    category: 'reversal',
    direction: 'LONG',
    entry: (i, c) => {
      const rsi = rsiAt(c, i)
      return rsi != null && rsi < 30 && isBullishReversal(c, i)
    },
    sl_atr: 1.5, tp_atr: 2.5, max_bars: 30,
  },
  rsi_overbought_rejection: {
    label: 'RSI Overbought Rejection',
    category: 'reversal',
    direction: 'SHORT',
    entry: (i, c) => {
      const rsi = rsiAt(c, i)
      return rsi != null && rsi > 70 && isBearishReversal(c, i)
    },
    sl_atr: 1.5, tp_atr: 2.5, max_bars: 30,
  },
  macd_bullish_cross_uptrend: {
    label: 'MACD Bull Cross in Uptrend',
    category: 'trend',
    direction: 'LONG',
    entry: (i, c) => {
      if (i < 35) return false
      const m = macdAt(c, i)
      const mPrev = macdAt(c, i - 1)
      const e50 = emaAt(c, i, 50)
      if (!m || !mPrev || !e50) return false
      const crossNow = m.macd > m.signal && mPrev.macd <= mPrev.signal
      const inUptrend = c[i].close > e50
      return crossNow && inUptrend
    },
    sl_atr: 2.0, tp_atr: 4.0, max_bars: 50,
  },
  macd_bearish_cross_downtrend: {
    label: 'MACD Bear Cross in Downtrend',
    category: 'trend',
    direction: 'SHORT',
    entry: (i, c) => {
      if (i < 35) return false
      const m = macdAt(c, i)
      const mPrev = macdAt(c, i - 1)
      const e50 = emaAt(c, i, 50)
      if (!m || !mPrev || !e50) return false
      const crossNow = m.macd < m.signal && mPrev.macd >= mPrev.signal
      const inDowntrend = c[i].close < e50
      return crossNow && inDowntrend
    },
    sl_atr: 2.0, tp_atr: 4.0, max_bars: 50,
  },
  bb_lower_touch_bounce: {
    label: 'Bollinger Lower Touch + Bounce',
    category: 'reversal',
    direction: 'LONG',
    entry: (i, c) => {
      const bb = bbAt(c, i)
      if (!bb) return false
      return c[i].low <= bb.lower && isBullishReversal(c, i)
    },
    sl_atr: 1.2, tp_atr: 2.0, max_bars: 20,
  },
  bb_upper_touch_rejection: {
    label: 'Bollinger Upper Touch + Rejection',
    category: 'reversal',
    direction: 'SHORT',
    entry: (i, c) => {
      const bb = bbAt(c, i)
      if (!bb) return false
      return c[i].high >= bb.upper && isBearishReversal(c, i)
    },
    sl_atr: 1.2, tp_atr: 2.0, max_bars: 20,
  },
  bb_squeeze_breakout_up: {
    label: 'BB Squeeze Breakout LONG',
    category: 'volatility',
    direction: 'LONG',
    entry: (i, c) => {
      if (i < 25) return false
      const bb = bbAt(c, i)
      const bbPrev5 = bbAt(c, i - 5)
      if (!bb || !bbPrev5) return false
      const widthNow = (bb.upper - bb.lower) / bb.middle
      const widthPrev = (bbPrev5.upper - bbPrev5.lower) / bbPrev5.middle
      // Era squeeze (bandwidth 5 bar fa era stretto), ora espansione + close sopra
      return widthPrev < 0.015 && widthNow > widthPrev * 1.5 && c[i].close > bb.upper
    },
    sl_atr: 2.0, tp_atr: 4.0, max_bars: 40,
  },
  bb_squeeze_breakout_down: {
    label: 'BB Squeeze Breakout SHORT',
    category: 'volatility',
    direction: 'SHORT',
    entry: (i, c) => {
      if (i < 25) return false
      const bb = bbAt(c, i)
      const bbPrev5 = bbAt(c, i - 5)
      if (!bb || !bbPrev5) return false
      const widthNow = (bb.upper - bb.lower) / bb.middle
      const widthPrev = (bbPrev5.upper - bbPrev5.lower) / bbPrev5.middle
      return widthPrev < 0.015 && widthNow > widthPrev * 1.5 && c[i].close < bb.lower
    },
    sl_atr: 2.0, tp_atr: 4.0, max_bars: 40,
  },
  ema_golden_cross: {
    label: 'EMA 50/200 Golden Cross',
    category: 'trend',
    direction: 'LONG',
    entry: (i, c) => {
      if (i < 201) return false
      const e50 = emaAt(c, i, 50)
      const e200 = emaAt(c, i, 200)
      const e50p = emaAt(c, i - 1, 50)
      const e200p = emaAt(c, i - 1, 200)
      if (e50 == null || e200 == null || e50p == null || e200p == null) return false
      return e50 > e200 && e50p <= e200p
    },
    sl_atr: 3.0, tp_atr: 6.0, max_bars: 80,
  },
  ema_death_cross: {
    label: 'EMA 50/200 Death Cross',
    category: 'trend',
    direction: 'SHORT',
    entry: (i, c) => {
      if (i < 201) return false
      const e50 = emaAt(c, i, 50)
      const e200 = emaAt(c, i, 200)
      const e50p = emaAt(c, i - 1, 50)
      const e200p = emaAt(c, i - 1, 200)
      if (e50 == null || e200 == null || e50p == null || e200p == null) return false
      return e50 < e200 && e50p >= e200p
    },
    sl_atr: 3.0, tp_atr: 6.0, max_bars: 80,
  },
  pullback_to_ema50_uptrend: {
    label: 'Pullback to EMA50 in Uptrend',
    category: 'trend',
    direction: 'LONG',
    entry: (i, c) => {
      if (i < 60) return false
      const e50 = emaAt(c, i, 50)
      const e200 = emaAt(c, i, 200)
      if (e50 == null || e200 == null) return false
      const inUptrend = e50 > e200 && c[i].close > e200
      const touchEma = c[i].low <= e50 * 1.002 && c[i].close > e50
      return inUptrend && touchEma && isBullishReversal(c, i)
    },
    sl_atr: 1.5, tp_atr: 3.0, max_bars: 30,
  },
  pullback_to_ema50_downtrend: {
    label: 'Pullback to EMA50 in Downtrend',
    category: 'trend',
    direction: 'SHORT',
    entry: (i, c) => {
      if (i < 60) return false
      const e50 = emaAt(c, i, 50)
      const e200 = emaAt(c, i, 200)
      if (e50 == null || e200 == null) return false
      const inDowntrend = e50 < e200 && c[i].close < e200
      const touchEma = c[i].high >= e50 * 0.998 && c[i].close < e50
      return inDowntrend && touchEma && isBearishReversal(c, i)
    },
    sl_atr: 1.5, tp_atr: 3.0, max_bars: 30,
  },
}

// ── Backtest engine ────────────────────────────────────────────────
/**
 * Esegue walk-forward backtest di un singolo setup.
 * @param {Array} candles  ultime N candele (≥ 100 raccomandate)
 * @param {Object} setup   un entry di SETUP_LIBRARY
 * @returns {Object}       statistiche
 */
export function backtestSetup(candles, setup) {
  const trades = []
  const startIdx = 200   // serve storia per indicatori (EMA200)
  const endIdx = candles.length - setup.max_bars - 1

  for (let i = startIdx; i < endIdx; i++) {
    if (!setup.entry(i, candles)) continue
    const entry = candles[i].close
    const atr = atrAt(candles, i)
    if (!atr || atr <= 0) continue

    const sl = setup.direction === 'LONG' ? entry - setup.sl_atr * atr : entry + setup.sl_atr * atr
    const tp = setup.direction === 'LONG' ? entry + setup.tp_atr * atr : entry - setup.tp_atr * atr
    const rUnit = setup.tp_atr / setup.sl_atr   // R-multiple on win

    // Walk-forward
    let outcome = null
    for (let j = i + 1; j <= Math.min(i + setup.max_bars, candles.length - 1); j++) {
      const c = candles[j]
      if (setup.direction === 'LONG') {
        if (c.low <= sl)  { outcome = { result: 'LOSS', R: -1, bars: j - i }; break }
        if (c.high >= tp) { outcome = { result: 'WIN',  R: rUnit, bars: j - i }; break }
      } else {
        if (c.high >= sl) { outcome = { result: 'LOSS', R: -1, bars: j - i }; break }
        if (c.low <= tp)  { outcome = { result: 'WIN',  R: rUnit, bars: j - i }; break }
      }
    }
    if (!outcome) outcome = { result: 'EXPIRED', R: 0, bars: setup.max_bars }
    trades.push(outcome)
  }

  const n = trades.length
  if (n === 0) {
    return { n_trades: 0, win_rate: null, avg_R: null, profit_factor: null, avg_hold_bars: null }
  }
  const wins = trades.filter(t => t.result === 'WIN').length
  const losses = trades.filter(t => t.result === 'LOSS').length
  const totWin = wins * (setup.tp_atr / setup.sl_atr)
  const totLoss = losses                                    // ogni perdita = 1R
  const profitFactor = losses > 0 ? (totWin / totLoss) : (totWin > 0 ? Infinity : null)
  return {
    n_trades:     n,
    wins,
    losses,
    expired:      trades.filter(t => t.result === 'EXPIRED').length,
    win_rate:     Math.round((wins / n) * 1000) / 10,                   // 1 decimal
    avg_R:        Math.round((trades.reduce((s, t) => s + t.R, 0) / n) * 100) / 100,
    profit_factor: profitFactor === Infinity ? null : (profitFactor != null ? Math.round(profitFactor * 100) / 100 : null),
    avg_hold_bars: Math.round(trades.reduce((s, t) => s + t.bars, 0) / n),
  }
}

/**
 * Esegue tutti i setup della library sulle candele fornite.
 * @param {Array} candles  ultime N candele (raccomandato 300+)
 * @returns {Object}       { setups: {key: stats}, evaluated_at, total_candles }
 */
export function runAllSetupBacktests(candles) {
  if (!Array.isArray(candles) || candles.length < 250) {
    return { setups: {}, evaluated_at: Date.now(), total_candles: candles?.length || 0, note: 'insufficient candles (need ≥250)' }
  }
  const setups = {}
  for (const [key, setup] of Object.entries(SETUP_LIBRARY)) {
    try {
      const stats = backtestSetup(candles, setup)
      setups[key] = {
        ...stats,
        label: setup.label,
        category: setup.category,
        direction: setup.direction,
        risk_reward: setup.tp_atr / setup.sl_atr,
      }
    } catch (err) {
      setups[key] = { error: err.message, label: setup.label }
    }
  }
  return {
    setups,
    evaluated_at: Date.now(),
    total_candles: candles.length,
  }
}

/**
 * Summary compatto per il prompt Claude (1-2 KB invece di JSON pesante).
 * Mostra solo i setup con n_trades ≥ 3 ordinati per |WR - 50%| desc.
 */
export function summarizeSetupBacktests(stats) {
  if (!stats?.setups) return null
  const entries = Object.entries(stats.setups)
    .filter(([k, v]) => v.n_trades >= 3)
    .map(([k, v]) => ({
      key: k,
      label: v.label,
      direction: v.direction,
      n: v.n_trades,
      wr: v.win_rate,
      r: v.avg_R,
      pf: v.profit_factor,
    }))
    .sort((a, b) => Math.abs((b.wr ?? 50) - 50) - Math.abs((a.wr ?? 50) - 50))
  return {
    note: 'WR computed on the LAST ~300 candles of this asset. Use as a filter: WR<40%=reduce confidence by 20, WR<30%=consider FLAT, WR>60%=boost confidence by 10',
    setups: entries,
    total: entries.length,
  }
}
