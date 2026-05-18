// HistoricalContext — fornisce a Claude la prospettiva storica.
// Senza storico, Claude valuta solo il "presente" senza capire se è caro/economico
// rispetto al range storico, dove sono i 52w high/low, ecc.

function round5(n) { return n != null ? Math.round(n * 100000) / 100000 : null }
function round2(n) { return n != null ? Math.round(n * 100) / 100 : null }

/**
 * Calcola statistiche storiche dalle candele disponibili.
 * Tipicamente con candele 1D si copre ~2 anni (730 candele).
 */
export function buildHistoricalContext(candles) {
  if (!candles || candles.length < 30) return null
  const last = candles[candles.length - 1]
  const closes = candles.map(c => c.close)
  const highs = candles.map(c => c.high)
  const lows = candles.map(c => c.low)
  const currentPrice = last.close

  // Periodi tipici (in candele) — funziona bene su qualsiasi TF
  const periods = {
    last_24:  Math.min(24, candles.length - 1),
    last_5d:  Math.min(120, candles.length - 1),    // 24 * 5
    last_30d: Math.min(720, candles.length - 1),
    last_90d: Math.min(2160, candles.length - 1),
  }

  const performance = {}
  for (const [label, n] of Object.entries(periods)) {
    if (n < 1) continue
    const start = closes[closes.length - 1 - n]
    if (!start) continue
    performance[label] = {
      pct:        round2(((currentPrice - start) / start) * 100),
      price_then: round5(start),
    }
  }

  // Range globale (tutte le candele disponibili)
  const allTimeHigh = Math.max(...highs)
  const allTimeLow  = Math.min(...lows)
  const distFromATH = round2(((currentPrice - allTimeHigh) / allTimeHigh) * 100)
  const distFromATL = round2(((currentPrice - allTimeLow) / allTimeLow) * 100)

  // Posizione percentile nel range storico (0 = min, 100 = max)
  const sortedCloses = [...closes].sort((a, b) => a - b)
  const rank = sortedCloses.findIndex(c => c >= currentPrice)
  const percentile = Math.round((rank / sortedCloses.length) * 100)

  // Recent high/low (ultime ~120 candele)
  const recentSlice = candles.slice(-Math.min(120, candles.length))
  const recentHigh = Math.max(...recentSlice.map(c => c.high))
  const recentLow  = Math.min(...recentSlice.map(c => c.low))
  const distFromRecentHigh = round2(((currentPrice - recentHigh) / recentHigh) * 100)
  const distFromRecentLow  = round2(((currentPrice - recentLow) / recentLow) * 100)

  // Volatilità storica annualizzata (basata su daily returns)
  const returns = []
  for (let i = 1; i < closes.length; i++) {
    if (closes[i - 1] > 0) returns.push(Math.log(closes[i] / closes[i - 1]))
  }
  const meanRet = returns.reduce((s, x) => s + x, 0) / returns.length
  const variance = returns.reduce((s, x) => s + (x - meanRet) ** 2, 0) / returns.length
  const dailyStd = Math.sqrt(variance)
  // Per annualizzare assumiamo TF daily o adatto (su forex ~252 giorni trading/anno)
  const annualizedVol = round2(dailyStd * Math.sqrt(252) * 100)

  // Trend recente: % volte chiuso bullish nelle ultime 50 candele
  const last50 = candles.slice(-50)
  const bullishBars = last50.filter(c => c.close > c.open).length
  const bullishRatio = round2(bullishBars / last50.length)

  // Posizione rispetto a mezzogiorno del range recente
  const recentMid = (recentHigh + recentLow) / 2
  const positionVsMid = currentPrice > recentMid ? 'upper-half' : 'lower-half'

  // Drawdown dal recent high
  const drawdownPct = round2(((currentPrice - recentHigh) / recentHigh) * 100)

  // Nuovi massimi/minimi nelle ultime N candele?
  const lastNHigh = recentSlice.length >= 30
    ? Math.max(...recentSlice.slice(-30).map(c => c.high))
    : null
  const lastNLow = recentSlice.length >= 30
    ? Math.min(...recentSlice.slice(-30).map(c => c.low))
    : null
  const at30dHigh = lastNHigh && currentPrice >= lastNHigh * 0.998
  const at30dLow  = lastNLow  && currentPrice <= lastNLow  * 1.002

  return {
    current_price:        round5(currentPrice),
    candles_available:    candles.length,

    performance,                            // % movement vari periodi

    range: {
      all_time_high:        round5(allTimeHigh),
      all_time_low:         round5(allTimeLow),
      distance_from_ath:    distFromATH,
      distance_from_atl:    distFromATL,
      percentile_in_range:  percentile,     // 0-100
    },

    recent: {
      high_recent_120:      round5(recentHigh),
      low_recent_120:       round5(recentLow),
      distance_from_high:   distFromRecentHigh,
      distance_from_low:    distFromRecentLow,
      drawdown_from_high:   drawdownPct,
      position:             positionVsMid,
      at_30d_high:          at30dHigh,
      at_30d_low:           at30dLow,
    },

    volatility: {
      annualized_pct:       annualizedVol,
      daily_std_pct:        round2(dailyStd * 100),
    },

    bias: {
      bullish_bars_50:      bullishBars,
      bullish_ratio:        bullishRatio,
    },
  }
}
