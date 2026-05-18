// Cross-asset correlation matrix usando Pearson coefficient sui returns
// Tutti i dati arrivano dalle candele già caricate — zero chiamate API esterne.

// Calcola log-returns da candele
function returns(candles, lookback = 100) {
  if (!candles || candles.length < 2) return []
  const slice = candles.slice(-lookback - 1)
  const r = []
  for (let i = 1; i < slice.length; i++) {
    const prev = slice[i - 1].close
    const cur  = slice[i].close
    if (prev > 0) r.push(Math.log(cur / prev))
  }
  return r
}

// Pearson correlation tra due array di stessa lunghezza
function pearson(a, b) {
  const n = Math.min(a.length, b.length)
  if (n < 10) return null
  const aa = a.slice(-n), bb = b.slice(-n)
  const meanA = aa.reduce((s, x) => s + x, 0) / n
  const meanB = bb.reduce((s, x) => s + x, 0) / n
  let num = 0, denA = 0, denB = 0
  for (let i = 0; i < n; i++) {
    const da = aa[i] - meanA, db = bb[i] - meanB
    num  += da * db
    denA += da * da
    denB += db * db
  }
  if (denA === 0 || denB === 0) return null
  return num / Math.sqrt(denA * denB)
}

/**
 * Costruisce matrice di correlazione fra tutti gli strumenti con candele disponibili.
 * @param {Object} instruments — store.instruments
 * @param {Number} lookback — quante candele usare
 * @returns {Object} { symbols, matrix: { sym1: { sym2: corr, ... }, ... } }
 */
export function calculateCorrelationMatrix(instruments, lookback = 100) {
  const symbols = Object.keys(instruments).filter(s =>
    instruments[s]?.candles?.length > 20
  )

  const returnsBySymbol = {}
  for (const s of symbols) {
    returnsBySymbol[s] = returns(instruments[s].candles, lookback)
  }

  const matrix = {}
  for (const s1 of symbols) {
    matrix[s1] = {}
    for (const s2 of symbols) {
      if (s1 === s2) { matrix[s1][s2] = 1; continue }
      matrix[s1][s2] = pearson(returnsBySymbol[s1], returnsBySymbol[s2])
    }
  }

  return { symbols, matrix }
}

/**
 * Restituisce le top correlazioni di uno strumento (positive e negative).
 */
export function getTopCorrelations(symbol, matrix, topN = 3) {
  if (!matrix[symbol]) return { positive: [], negative: [] }
  const entries = Object.entries(matrix[symbol])
    .filter(([s, v]) => s !== symbol && v != null)
    .sort((a, b) => b[1] - a[1])
  return {
    positive: entries.slice(0, topN).map(([s, v]) => ({ symbol: s, corr: v })),
    negative: entries.slice(-topN).reverse().map(([s, v]) => ({ symbol: s, corr: v })),
  }
}

/**
 * Cross-confirm: dato symbol e direzione, verifica se le correlazioni positive
 * stanno andando nella stessa direzione (conferma) o opposta (divergenza).
 */
export function crossAssetConfirmation(symbol, direction, instruments, matrix) {
  if (!matrix[symbol]) return null
  const corrEntries = Object.entries(matrix[symbol])
    .filter(([s, v]) => s !== symbol && v != null && Math.abs(v) > 0.5)

  if (corrEntries.length === 0) return null

  let confirms = 0
  let diverges = 0
  const details = []

  for (const [s, corr] of corrEntries) {
    const inst = instruments[s]
    if (!inst?.candles || inst.candles.length < 20) continue
    // Trend dello strumento correlato (ultime 20 candele)
    const last20 = inst.candles.slice(-20)
    const start = last20[0].close
    const end   = last20[last20.length - 1].close
    if (start === 0) continue
    const trendPct = (end - start) / start
    const isUp = trendPct > 0.001
    const isDown = trendPct < -0.001
    if (!isUp && !isDown) continue

    // Se corr > 0: stesso movimento conferma. Se corr < 0: movimento opposto conferma.
    const expectedSameDirection = corr > 0
    const correlatedDirection = expectedSameDirection ? (direction === 'LONG' ? isUp : isDown)
                                                       : (direction === 'LONG' ? isDown : isUp)
    if (correlatedDirection) {
      confirms++
      details.push({ symbol: s, corr, status: 'confirm' })
    } else {
      diverges++
      details.push({ symbol: s, corr, status: 'diverge' })
    }
  }

  const total = confirms + diverges
  if (total === 0) return null
  const score = ((confirms - diverges) / total) * 30   // ±30 max
  return {
    confirms, diverges, total,
    score,
    details,
    label: score > 10 ? 'Conferma cross-asset' : score < -10 ? 'Divergenza cross-asset' : 'Cross-asset misto',
  }
}
