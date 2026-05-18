// PatternsEngine — aggregatore dei tre detection engine.
// Combina candlestick, chart e harmonic patterns in un unico output.
import { detectCandlestickPatterns } from './CandlestickPatterns'
import { detectChartPatterns }       from './ChartPatterns'
import { detectHarmonicPatterns }    from './HarmonicPatterns'

/**
 * Restituisce tutti i pattern detectati ordinati dal più recente.
 * Filtra: candlestick solo ultime 30 candele, chart 100, harmonic 150.
 */
export function detectAllPatterns(candles) {
  if (!candles || candles.length < 30) return []
  const candle = detectCandlestickPatterns(candles, 30)
  const chart  = detectChartPatterns(candles, 100)
  const harmonic = detectHarmonicPatterns(candles, 150)
  return [...candle, ...chart, ...harmonic]
    .sort((a, b) => (b.time || 0) - (a.time || 0))
}

// Sintesi compatta per ContextPack — solo i pattern più rilevanti
export function summarizePatterns(patterns, maxPerCategory = 3) {
  if (!patterns || patterns.length === 0) return null
  const candle   = patterns.filter(p => p.type === 'candlestick').slice(0, maxPerCategory)
  const chart    = patterns.filter(p => p.type === 'chart').slice(0, maxPerCategory)
  const harmonic = patterns.filter(p => p.type === 'harmonic').slice(0, maxPerCategory)

  const compact = (p) => {
    const base = { name: p.name, bias: p.bias, reliability: p.reliability }
    if (p.type === 'chart' && p.neckline) {
      base.neckline = Math.round(p.neckline * 100000) / 100000
      base.target = Math.round(p.target * 100000) / 100000
      base.confirmed = p.confirmed
    }
    if (p.type === 'harmonic') {
      base.prz = Math.round(p.prz * 100000) / 100000
      base.sl  = Math.round(p.sl  * 100000) / 100000
      base.tp1 = Math.round(p.tp1 * 100000) / 100000
      base.tp2 = Math.round(p.tp2 * 100000) / 100000
      base.ratios = p.ratios
    }
    return base
  }

  const out = {}
  if (candle.length)   out.candlestick = candle.map(compact)
  if (chart.length)    out.chart       = chart.map(compact)
  if (harmonic.length) out.harmonic    = harmonic.map(compact)
  // Bias dominante
  const allBias = [...candle, ...chart, ...harmonic]
  const bullCount = allBias.filter(p => p.bias === 'bullish').length
  const bearCount = allBias.filter(p => p.bias === 'bearish').length
  out.dominant_bias = bullCount > bearCount ? 'bullish' : bearCount > bullCount ? 'bearish' : 'neutral'
  out.bullish_count = bullCount
  out.bearish_count = bearCount
  return out
}

// Score per ScoringEngine: -100..+100 basato sui pattern attivi
export function patternsScore(patterns) {
  if (!patterns || patterns.length === 0) return 0
  let score = 0
  const weights = { high: 12, medium: 7, low: 3 }
  for (const p of patterns) {
    const w = weights[p.reliability] || 5
    if (p.bias === 'bullish') score += w
    else if (p.bias === 'bearish') score -= w
  }
  // Boost extra per harmonic (più affidabili)
  const harmonics = patterns.filter(p => p.type === 'harmonic')
  for (const h of harmonics) {
    if (h.bias === 'bullish') score += 8
    else if (h.bias === 'bearish') score -= 8
  }
  return Math.max(-100, Math.min(100, score))
}
