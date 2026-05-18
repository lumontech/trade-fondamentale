// BacktestStatistics — significatività statistica + walk-forward + confidence intervals.
// Aiuta a distinguere "edge reale" da "rumore con poche occorrenze".

// ── Wilson score interval (binomial CI per win rate) ───────────────
// Più accurato della normal approximation con N piccolo.
// Returns: { lower, upper, point } — intervallo al 95% (z=1.96)
export function winRateConfidenceInterval(wins, total, z = 1.96) {
  if (total === 0) return { lower: 0, upper: 0, point: 0 }
  const p = wins / total
  const denom = 1 + (z * z) / total
  const center = (p + (z * z) / (2 * total)) / denom
  const margin = (z * Math.sqrt((p * (1 - p) + (z * z) / (4 * total)) / total)) / denom
  return {
    lower: Math.max(0, center - margin),
    upper: Math.min(1, center + margin),
    point: p,
    width: 2 * margin,
  }
}

// ── Significance flag ──────────────────────────────────────────────
// Classificazione standard nella ricerca quant retail:
// < 30 trade   = unreliable
// 30-100 trade = limited
// 100+ trade   = decent
// 250+ trade   = robust
export function significanceLevel(occurrences) {
  if (occurrences < 10)  return { level: 'noise',     label: 'Rumore',     color: '#ff3355', stars: 0,
                                  hint: 'Troppi pochi trade. Numeri non affidabili.' }
  if (occurrences < 30)  return { level: 'unreliable',label: 'Inaffidabile', color: '#ff7a8d', stars: 1,
                                  hint: 'Statistica debole. Conferma con più dati o altro TF.' }
  if (occurrences < 100) return { level: 'limited',   label: 'Limitato',   color: '#f5c842', stars: 2,
                                  hint: 'Indicativo ma non robusto.' }
  if (occurrences < 250) return { level: 'decent',    label: 'Decente',    color: '#7be0a3', stars: 3,
                                  hint: 'Statisticamente significativo.' }
  return { level: 'robust', label: 'Robusto', color: '#00e096', stars: 4,
           hint: 'Sample size ampio. Edge probabilmente reale.' }
}

// ── Statistical test: WR > 50% (one-sample binomial) ───────────────
// Restituisce p-value approssimato (z-test su proporzione)
// H0: WR = 0.5  vs  H1: WR > 0.5
export function isWinRateSignificantlyAboveRandom(wins, total, threshold = 0.5) {
  if (total < 10) return { significant: false, pValue: 1, zScore: 0 }
  const p = wins / total
  const se = Math.sqrt(threshold * (1 - threshold) / total)
  const z = (p - threshold) / se
  // p-value one-sided con normal approximation
  const pValue = 1 - normalCDF(z)
  return {
    significant: pValue < 0.05,
    pValue: Math.max(0, Math.min(1, pValue)),
    zScore: z,
    edge: p - threshold,
  }
}

// Approssimazione CDF normale standard (Abramowitz-Stegun 26.2.17)
function normalCDF(x) {
  if (x < -6) return 0
  if (x > 6)  return 1
  const a1 =  0.254829592, a2 = -0.284496736, a3 =  1.421413741
  const a4 = -1.453152027, a5 =  1.061405429, p = 0.3275911
  const sign = x < 0 ? -1 : 1
  x = Math.abs(x) / Math.sqrt(2)
  const t = 1 / (1 + p * x)
  const y = 1 - (((((a5*t + a4)*t) + a3)*t + a2)*t + a1)*t * Math.exp(-x*x)
  return 0.5 * (1 + sign * y)
}

// ── Walk-forward split ─────────────────────────────────────────────
// Divide i trade in due porzioni cronologiche: train + test out-of-sample.
// Se le metriche test sono molto peggiori del train → overfit / regime change.
/**
 * @param {Array} trades - lista trade ordinata cronologicamente
 * @param {number} trainPct - frazione train (default 0.7)
 * @returns {Object} { train: stats, test: stats, divergence: 0..1, overfit: bool }
 */
export function walkForwardSplit(trades, trainPct = 0.7) {
  if (!trades || trades.length < 10) {
    return { error: 'Troppi pochi trade per walk-forward' }
  }
  const sorted = [...trades].sort((a, b) => (a.time || a.bar) - (b.time || b.bar))
  const splitAt = Math.floor(sorted.length * trainPct)
  const train = sorted.slice(0, splitAt)
  const test  = sorted.slice(splitAt)

  const stats = (list) => {
    if (list.length === 0) return null
    const wins = list.filter(t => t.outcome === 'tp' || (t.win === true)).length
    const closed = list.filter(t => t.outcome === 'tp' || t.outcome === 'sl').length
    const wr = closed > 0 ? wins / closed : 0
    const sumR = list.reduce((s, t) => s + (t.rr || 0), 0)
    const avgR = list.length > 0 ? sumR / list.length : 0
    const grossWin = wins * 2  // approx 2:1 RR
    const losses = closed - wins
    const grossLoss = losses
    const pf = grossLoss > 0 ? grossWin / grossLoss : (grossWin > 0 ? Infinity : 0)
    return { total: list.length, wins, losses, winRate: wr, avgR, profitFactor: pf }
  }

  const trainStats = stats(train)
  const testStats  = stats(test)

  // Divergence: quanto il test è peggiore del train (in WR e avgR)
  let divergence = 0
  let overfit = false
  if (trainStats && testStats && trainStats.total > 5 && testStats.total > 5) {
    const wrDelta = trainStats.winRate - testStats.winRate
    const rDelta  = trainStats.avgR    - testStats.avgR
    divergence = Math.max(0, wrDelta) * 0.5 + Math.max(0, rDelta) * 0.3
    // Overfit se test WR cala più del 15% rispetto al train E test PF < 1
    overfit = wrDelta > 0.15 && testStats.profitFactor < 1
  }

  return {
    train: trainStats,
    test:  testStats,
    divergence: Math.round(divergence * 100) / 100,
    overfit,
    splitDate: train.length > 0 ? train[train.length - 1].time : null,
  }
}

// ── Sharpe / Sortino su array di R-returns ─────────────────────────
export function calculateRiskMetrics(rReturns) {
  if (!rReturns || rReturns.length < 5) return { sharpe: null, sortino: null }
  const mean = rReturns.reduce((s, x) => s + x, 0) / rReturns.length
  const variance = rReturns.reduce((s, x) => s + (x - mean) ** 2, 0) / rReturns.length
  const std = Math.sqrt(variance)
  const sharpe = std > 0 ? mean / std : null
  const negs = rReturns.filter(x => x < 0)
  const downStd = negs.length > 0 ? Math.sqrt(negs.reduce((s, x) => s + x * x, 0) / negs.length) : 0
  const sortino = downStd > 0 ? mean / downStd : (mean > 0 ? Infinity : null)
  return {
    sharpe:  sharpe  != null ? Math.round(sharpe  * 100) / 100 : null,
    sortino: sortino === Infinity ? Infinity : sortino != null ? Math.round(sortino * 100) / 100 : null,
  }
}
