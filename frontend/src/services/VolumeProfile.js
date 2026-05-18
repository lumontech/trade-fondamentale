// Volume Profile — distribuzione del volume per livello di prezzo (non per tempo).
// POC = Point of Control (prezzo con più volume)
// VAH/VAL = Value Area High/Low (70% del volume totale)
// HVN/LVN = High/Low Volume Nodes (zone di accettazione/rifiuto)

/**
 * Calcola Volume Profile per le ultime N candele.
 * @param {Array} candles - array di { open, high, low, close, volume, time }
 * @param {Number} lookback - quante candele considerare
 * @param {Number} bins - quanti livelli di prezzo (default 30)
 * @returns {Object} { profile, poc, vah, val, hvn, lvn, total_volume, range }
 */
export function calculateVolumeProfile(candles, lookback = 100, bins = 30) {
  if (!candles || candles.length < 20) return null
  const slice = candles.slice(-lookback)

  // Range di prezzo
  let minPrice = Infinity, maxPrice = -Infinity
  for (const c of slice) {
    if (c.low < minPrice) minPrice = c.low
    if (c.high > maxPrice) maxPrice = c.high
  }
  if (maxPrice === minPrice) return null

  const binSize = (maxPrice - minPrice) / bins

  // Distribuisce il volume di ogni candela proporzionalmente sui bin che attraversa
  const buckets = new Array(bins).fill(0)
  for (const c of slice) {
    if (!c.volume || c.volume <= 0) continue
    const lowIdx = Math.max(0, Math.floor((c.low - minPrice) / binSize))
    const highIdx = Math.min(bins - 1, Math.floor((c.high - minPrice) / binSize))
    const span = Math.max(1, highIdx - lowIdx + 1)
    const volPerBin = c.volume / span
    for (let i = lowIdx; i <= highIdx; i++) {
      buckets[i] += volPerBin
    }
  }

  const totalVolume = buckets.reduce((s, v) => s + v, 0)
  if (totalVolume === 0) return null

  // POC: bin con max volume
  let pocIdx = 0
  for (let i = 1; i < bins; i++) {
    if (buckets[i] > buckets[pocIdx]) pocIdx = i
  }
  const poc = minPrice + (pocIdx + 0.5) * binSize

  // Value Area: 70% del volume centrato sul POC, espandendo greedy verso i bin con più volume
  const targetVolume = totalVolume * 0.7
  let included = new Set([pocIdx])
  let valArea = buckets[pocIdx]
  let lowIdx = pocIdx, highIdx = pocIdx
  while (valArea < targetVolume && (lowIdx > 0 || highIdx < bins - 1)) {
    const upVol = highIdx + 1 < bins ? buckets[highIdx + 1] : -1
    const downVol = lowIdx - 1 >= 0 ? buckets[lowIdx - 1] : -1
    if (upVol >= downVol && upVol >= 0) {
      highIdx++
      included.add(highIdx)
      valArea += buckets[highIdx]
    } else if (downVol >= 0) {
      lowIdx--
      included.add(lowIdx)
      valArea += buckets[lowIdx]
    } else break
  }
  const vah = minPrice + (highIdx + 1) * binSize
  const val = minPrice + lowIdx * binSize

  // HVN/LVN: top 3 high volume bins, bottom 3 low volume bins (escluso 0)
  const sortedBins = buckets.map((vol, i) => ({
    price: minPrice + (i + 0.5) * binSize,
    volume: vol,
    pct: (vol / totalVolume) * 100,
    inValueArea: included.has(i),
  })).filter(b => b.volume > 0)

  const sortedByVol = [...sortedBins].sort((a, b) => b.volume - a.volume)
  const hvn = sortedByVol.slice(0, 3).map(b => ({
    price: Math.round(b.price * 100000) / 100000,
    pct: Math.round(b.pct * 10) / 10,
  }))
  const lvn = sortedByVol.slice(-3).reverse().map(b => ({
    price: Math.round(b.price * 100000) / 100000,
    pct: Math.round(b.pct * 10) / 10,
  }))

  return {
    profile: sortedBins,
    poc:           Math.round(poc * 100000) / 100000,
    vah:           Math.round(vah * 100000) / 100000,
    val:           Math.round(val * 100000) / 100000,
    hvn, lvn,
    total_volume:  totalVolume,
    range:         { min: minPrice, max: maxPrice },
    bins,
    binSize,
  }
}

// Sintesi compatta per ContextPack
export function summarizeVolumeProfile(vp) {
  if (!vp) return null
  return {
    poc: vp.poc,
    vah: vp.vah,
    val: vp.val,
    hvn: vp.hvn,
    lvn: vp.lvn,
  }
}
