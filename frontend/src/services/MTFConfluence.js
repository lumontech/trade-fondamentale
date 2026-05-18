// Multi-Timeframe Confluence — calcola segnale tecnico su ogni TF disponibile
// e produce uno score di consenso. Più TF d'accordo = setup più affidabile.
import { calculateSignal } from '../utils/indicators'

const TF_WEIGHTS = {
  '1D':  3.0,    // trend direzionale macro
  '4h':  2.0,    // bias di medio periodo
  '1h':  1.5,    // setup operativo
  '15m': 1.0,    // timing entry
}

const TF_ORDER = ['1D', '4h', '1h', '15m']

function signalToBias(label) {
  if (!label) return 0
  if (label === 'COMPRA FORTE') return 2
  if (label === 'COMPRA')       return 1
  if (label === 'VENDI')        return -1
  if (label === 'VENDI FORTE')  return -2
  return 0
}

/**
 * Restituisce analisi MTF per uno strumento.
 * @returns {{
 *   timeframes: { [tf]: { label, score, bias } },
 *   confluenceScore: number,    // -100..+100
 *   alignedCount: number,        // quanti TF concordano sulla direzione dominante
 *   totalCount: number,          // quanti TF analizzati
 *   dominantBias: 'long'|'short'|'mixed',
 *   weightedBias: number,        // -1..+1
 * }}
 */
export function calculateMTFConfluence(instrument) {
  if (!instrument) return null
  const mtf = instrument.mtf || {}

  const timeframes = {}
  let totalWeight = 0
  let weightedSum = 0

  for (const tf of TF_ORDER) {
    const candles = mtf[tf]
    if (!candles || candles.length < 50) continue
    const sig = calculateSignal(candles)
    if (!sig) continue
    const bias = signalToBias(sig.label)
    const weight = TF_WEIGHTS[tf] || 1.0
    timeframes[tf] = {
      label: sig.label,
      score: sig.score,
      bias,
      weight,
    }
    totalWeight += weight * Math.abs(bias)
    weightedSum += weight * bias
  }

  const totalCount = Object.keys(timeframes).length
  if (totalCount === 0) return null

  // Bias pesato normalizzato
  const maxWeight = Object.values(TF_WEIGHTS).reduce((s, w) => s + w * 2, 0) // bias max ±2
  const weightedBias = weightedSum / maxWeight   // -1..+1

  // Conta direzioni concordanti
  const longTFs  = Object.values(timeframes).filter(t => t.bias > 0).length
  const shortTFs = Object.values(timeframes).filter(t => t.bias < 0).length
  const neutralTFs = totalCount - longTFs - shortTFs

  let dominantBias = 'mixed'
  let alignedCount = 0
  if (longTFs > shortTFs) {
    dominantBias = 'long'
    alignedCount = longTFs
  } else if (shortTFs > longTFs) {
    dominantBias = 'short'
    alignedCount = shortTFs
  }

  // Confluence score: -100..+100 (segnato)
  const confluenceScore = Math.round(weightedBias * 100)

  return {
    timeframes,
    confluenceScore,
    alignedCount,
    neutralCount: neutralTFs,
    totalCount,
    dominantBias,
    weightedBias,
  }
}

// Sintesi compatta per ContextPack
export function summarizeMTF(confluence) {
  if (!confluence) return null
  return {
    confluence_score:  confluence.confluenceScore,
    dominant_bias:     confluence.dominantBias,
    aligned:           `${confluence.alignedCount}/${confluence.totalCount}`,
    by_timeframe:      Object.fromEntries(
      Object.entries(confluence.timeframes).map(([tf, t]) => [tf, t.label])
    ),
  }
}
