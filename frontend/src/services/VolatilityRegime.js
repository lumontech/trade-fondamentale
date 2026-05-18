// Volatility Regime Detection — capire se il mercato è in TREND o RANGE.
// Una strategia EMA crossover funziona solo in trend; in range è disastrosa.
// Combina ADX (Average Directional Index) e Bollinger Bandwidth.

// ── ADX ───────────────────────────────────────────────────────────
// Misura la forza del trend (NON la direzione).
// ADX > 25 = trend forte. ADX < 20 = range/no-trend.
function calculateADX(candles, period = 14) {
  if (candles.length < period * 2 + 1) return null

  const tr = []
  const plusDM = []
  const minusDM = []

  for (let i = 1; i < candles.length; i++) {
    const c = candles[i], p = candles[i - 1]
    const trueRange = Math.max(
      c.high - c.low,
      Math.abs(c.high - p.close),
      Math.abs(c.low - p.close)
    )
    const upMove = c.high - p.high
    const downMove = p.low - c.low
    tr.push(trueRange)
    plusDM.push(upMove > downMove && upMove > 0 ? upMove : 0)
    minusDM.push(downMove > upMove && downMove > 0 ? downMove : 0)
  }

  // Wilder smoothing
  const smooth = (arr, p) => {
    const result = []
    let s = arr.slice(0, p).reduce((a, b) => a + b, 0)
    result.push(s)
    for (let i = p; i < arr.length; i++) {
      s = s - s / p + arr[i]
      result.push(s)
    }
    return result
  }

  const trS = smooth(tr, period)
  const plusDMS = smooth(plusDM, period)
  const minusDMS = smooth(minusDM, period)

  const dx = []
  for (let i = 0; i < trS.length; i++) {
    const plusDI = (plusDMS[i] / trS[i]) * 100
    const minusDI = (minusDMS[i] / trS[i]) * 100
    const diSum = plusDI + minusDI
    if (diSum === 0) dx.push(0)
    else dx.push(Math.abs(plusDI - minusDI) / diSum * 100)
  }

  if (dx.length < period) return null
  let adx = dx.slice(0, period).reduce((a, b) => a + b, 0) / period
  for (let i = period; i < dx.length; i++) {
    adx = (adx * (period - 1) + dx[i]) / period
  }
  return adx
}

// ── Bollinger Bandwidth percentile ────────────────────────────────
// Bandwidth = (upper - lower) / middle. Misura la volatilità.
// Alta volatility (top 20%) = trend o expansion phase.
// Bassa (bottom 20%) = squeeze = mercato in attesa di breakout.
function calculateBBWidth(candles, period = 20, mult = 2) {
  if (candles.length < period + 1) return null
  const widths = []
  for (let i = period - 1; i < candles.length; i++) {
    const slice = candles.slice(i - period + 1, i + 1).map(c => c.close)
    const mean = slice.reduce((a, b) => a + b, 0) / period
    const variance = slice.reduce((s, x) => s + (x - mean) ** 2, 0) / period
    const std = Math.sqrt(variance)
    const width = (2 * mult * std) / mean * 100   // %
    widths.push(width)
  }
  return widths
}

// Percentile rank della BB width corrente nelle ultime N
function bbWidthPercentile(widths, lookback = 100) {
  if (!widths || widths.length === 0) return null
  const recent = widths.slice(-Math.min(lookback, widths.length))
  const current = widths[widths.length - 1]
  const below = recent.filter(w => w < current).length
  return below / recent.length   // 0-1
}

/**
 * Restituisce regime + metriche.
 * regime: 'strong-trend' | 'trend' | 'transition' | 'range' | 'squeeze'
 */
export function detectVolatilityRegime(candles) {
  const adx = calculateADX(candles, 14)
  const widths = calculateBBWidth(candles, 20, 2)
  const bbwPct = bbWidthPercentile(widths, 100)
  const currentWidth = widths?.[widths.length - 1]

  if (adx == null || bbwPct == null) return null

  let regime
  if (adx >= 35) regime = 'strong-trend'
  else if (adx >= 25 && bbwPct > 0.5) regime = 'trend'
  else if (adx < 20 && bbwPct < 0.2) regime = 'squeeze'      // bassa volatilità → breakout in arrivo
  else if (adx < 20) regime = 'range'
  else regime = 'transition'

  return {
    regime,
    adx:        Math.round(adx * 10) / 10,
    bb_width:   currentWidth ? Math.round(currentWidth * 100) / 100 : null,
    bb_width_percentile: Math.round(bbwPct * 100),
    strategy_hint:
      regime === 'strong-trend' ? 'trend-following: lascia correre i profitti'
      : regime === 'trend' ? 'trend-following: entry sui pullback, evita reversal'
      : regime === 'squeeze' ? 'attesa breakout: SL stretti, prepara entry su volatility expansion'
      : regime === 'range' ? 'mean-reversion: vendi in resistenza, compra in supporto'
      : 'mercato indeciso: ridurre size, aspettare conferma',
  }
}
