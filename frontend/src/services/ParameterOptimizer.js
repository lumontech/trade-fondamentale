// ParameterOptimizer — grid search sui parametri del backtest.
// Gira centinaia di combinazioni e produce tabella ordinabile + cluster analysis.
// Ispirato alla metodologia del video ATR Breakout di Pythagorian Investments.
import { runBacktest } from './BacktestEngine'

/**
 * Genera tutte le combinazioni dei parametri specificati.
 * Esempio: { atrPeriod: [10, 14, 20], slMultiplier: [1.5, 2.0] }
 *   → [{atrPeriod:10, slMultiplier:1.5}, {atrPeriod:10, slMultiplier:2.0}, ...]
 */
function cartesianProduct(paramsRanges) {
  const keys = Object.keys(paramsRanges)
  if (keys.length === 0) return [{}]
  let result = [{}]
  for (const key of keys) {
    const newResult = []
    for (const combo of result) {
      for (const value of paramsRanges[key]) {
        newResult.push({ ...combo, [key]: value })
      }
    }
    result = newResult
  }
  return result
}

/**
 * Esegue il grid-search ottimizzazione su tutte le combinazioni.
 *
 * @param {Array} candles - candele dello strumento
 * @param {Object} paramsRanges - es. { atrPeriod: [10,14,20], slMultiplier: [1.0,1.5,2.0], tpMultiplier: [2,3,4], maxBars: [20,30,40] }
 * @param {Function} onProgress - callback (current, total) per UI
 * @returns {Array} risultati ordinati per profitFactor desc
 */
export async function runOptimization(candles, paramsRanges, onProgress = null) {
  const combinations = cartesianProduct(paramsRanges)
  const total = combinations.length
  const results = []

  for (let i = 0; i < combinations.length; i++) {
    const params = combinations[i]
    try {
      const bt = runBacktest(candles, params)
      if (!bt.summary || bt.summary.total === 0) continue
      results.push({
        params,
        ...bt.summary,
      })
    } catch (err) {
      // Skip combinazioni con errore
    }
    if (onProgress) onProgress(i + 1, total)
    // Yield al browser ogni 10 backtest per non bloccare UI
    if (i % 10 === 0 && i > 0) {
      await new Promise(r => setTimeout(r, 0))
    }
  }

  // Ordina per profit factor desc (default)
  results.sort((a, b) => {
    const pfA = isFinite(a.profitFactor) ? a.profitFactor : 999
    const pfB = isFinite(b.profitFactor) ? b.profitFactor : 999
    return pfB - pfA
  })

  return results
}

/**
 * Cluster analysis ispirata al video Pythagorian:
 * Per ogni parametro, confronta i valori dominanti nei TOP 20% vs BOTTOM 20%.
 * Se sono diversi → parametro significativo. Se sono uguali → irrilevante.
 *
 * @returns {Array} insights per ogni parametro
 */
export function analyzeParameterSignificance(results) {
  if (!results || results.length < 10) return []

  const topN = Math.max(5, Math.floor(results.length * 0.2))
  const bottomN = Math.max(5, Math.floor(results.length * 0.2))
  const top    = results.slice(0, topN)
  const bottom = results.slice(-bottomN)

  const params = Object.keys(results[0].params)
  const insights = []

  for (const param of params) {
    const topValues    = top.map(r => r.params[param])
    const bottomValues = bottom.map(r => r.params[param])

    // Frequenza di ogni valore in top e bottom
    const freq = (arr) => {
      const f = {}
      for (const v of arr) f[String(v)] = (f[String(v)] || 0) + 1
      return f
    }
    const topFreq = freq(topValues)
    const botFreq = freq(bottomValues)

    // Valore dominante
    const topDom = Object.entries(topFreq).sort((a, b) => b[1] - a[1])[0]
    const botDom = Object.entries(botFreq).sort((a, b) => b[1] - a[1])[0]

    // % dominanza
    const topPct = topDom[1] / topValues.length
    const botPct = botDom[1] / bottomValues.length

    let significance = 'low'
    let conclusion = 'Parametro non significativo (stesso valore vince sia in top che bottom)'
    if (topDom[0] !== botDom[0] && topPct > 0.4 && botPct > 0.4) {
      significance = 'high'
      conclusion = `Top usa ${topDom[0]} (${(topPct*100).toFixed(0)}%), bottom usa ${botDom[0]} (${(botPct*100).toFixed(0)}%) → parametro determinante`
    } else if (topDom[0] !== botDom[0]) {
      significance = 'medium'
      conclusion = `Lieve preferenza: top→${topDom[0]}, bottom→${botDom[0]}`
    }

    insights.push({
      param,
      top_dominant:    topDom[0],
      top_dominance:   Math.round(topPct * 100),
      bottom_dominant: botDom[0],
      bottom_dominance: Math.round(botPct * 100),
      significance,
      conclusion,
    })
  }
  return insights
}

// Preset di range parametrici (stile video Pythagorian)
export const OPTIMIZATION_PRESETS = {
  quick: {
    label: 'Rapido (~36 backtest)',
    description: 'Test rapido per vedere se la strategia funziona',
    ranges: {
      atrPeriod:    [10, 14, 20],
      slMultiplier: [1.0, 1.5, 2.0],
      tpMultiplier: [2.0, 3.0],
      maxBars:      [20, 30],
    },
  },
  standard: {
    label: 'Standard (~144 backtest)',
    description: 'Bilanciato tra precisione e tempo',
    ranges: {
      atrPeriod:    [10, 14, 20, 30],
      slMultiplier: [0.5, 1.0, 1.5, 2.0],
      tpMultiplier: [1.5, 2.0, 3.0],
      maxBars:      [20, 30, 50],
    },
  },
  deep: {
    label: 'Profondo (~480 backtest, ~1-2 min)',
    description: 'Esplorazione esaustiva ispirata al video Pythagorian',
    ranges: {
      atrPeriod:    [10, 14, 20, 30, 50],
      slMultiplier: [0.5, 1.0, 1.5, 2.0, 2.5],
      tpMultiplier: [1.5, 2.0, 2.5, 3.0],
      maxBars:      [15, 20, 30, 50, 100],
    },
  },
}
