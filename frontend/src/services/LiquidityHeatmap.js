// Liquidity Heatmap — identifica le zone dove tipicamente sono i stop dei retail.
// Concetti SMC: equal highs/lows, liquidity grabs, BSL/SSL.
// Le banche/fondi vanno spesso a colpire queste zone prima di invertire.

/**
 * Trova "equal highs" (resistenze testate ripetutamente) e "equal lows".
 * Sono zone di alta liquidità (stop loss accumulati).
 */
function findEqualLevels(candles, tolerance = 0.0008, minTouches = 2) {
  // tolerance = % di tolleranza per considerare un livello "uguale"
  const highs = []
  const lows = []

  for (let i = 0; i < candles.length; i++) {
    const c = candles[i]
    // Aggrega ad un cluster esistente se vicino
    let added = false
    for (const cluster of highs) {
      if (Math.abs(c.high - cluster.price) / cluster.price < tolerance) {
        cluster.touches++
        cluster.lastIndex = i
        cluster.price = (cluster.price * (cluster.touches - 1) + c.high) / cluster.touches
        added = true
        break
      }
    }
    if (!added) highs.push({ price: c.high, touches: 1, lastIndex: i, firstIndex: i })

    added = false
    for (const cluster of lows) {
      if (Math.abs(c.low - cluster.price) / cluster.price < tolerance) {
        cluster.touches++
        cluster.lastIndex = i
        cluster.price = (cluster.price * (cluster.touches - 1) + c.low) / cluster.touches
        added = true
        break
      }
    }
    if (!added) lows.push({ price: c.low, touches: 1, lastIndex: i, firstIndex: i })
  }

  return {
    bsl: highs.filter(h => h.touches >= minTouches).sort((a, b) => b.touches - a.touches).slice(0, 5),
    ssl: lows.filter (l => l.touches >= minTouches).sort((a, b) => b.touches - a.touches).slice(0, 5),
  }
}

/**
 * Calcola la liquidity heatmap dello strumento.
 * Restituisce le zone di liquidità sopra (BSL = Buy Side Liquidity = stop dei short)
 * e sotto (SSL = Sell Side Liquidity = stop dei long).
 */
export function calculateLiquidityHeatmap(candles, lookback = 100) {
  if (!candles || candles.length < 30) return null
  const slice = candles.slice(-lookback)
  const lastClose = slice[slice.length - 1].close

  const { bsl, ssl } = findEqualLevels(slice, 0.0008, 2)

  // Filtra: BSL sopra il prezzo attuale, SSL sotto
  const bslAbove = bsl.filter(b => b.price > lastClose).map(b => ({
    price: Math.round(b.price * 100000) / 100000,
    touches: b.touches,
    distance_pct: Math.round(((b.price - lastClose) / lastClose) * 10000) / 100,
    age_bars: slice.length - 1 - b.lastIndex,
  })).slice(0, 4)

  const sslBelow = ssl.filter(s => s.price < lastClose).map(s => ({
    price: Math.round(s.price * 100000) / 100000,
    touches: s.touches,
    distance_pct: Math.round(((s.price - lastClose) / lastClose) * 10000) / 100,
    age_bars: slice.length - 1 - s.lastIndex,
  })).slice(0, 4)

  // Liquidity più "appetibile": vicina + molti touches
  const score = (z) => z.touches * 10 / Math.max(0.1, Math.abs(z.distance_pct))
  const targetUp = bslAbove.length > 0
    ? bslAbove.reduce((best, z) => score(z) > score(best) ? z : best)
    : null
  const targetDown = sslBelow.length > 0
    ? sslBelow.reduce((best, z) => score(z) > score(best) ? z : best)
    : null

  return {
    bsl_above:  bslAbove,    // zone sopra: prezzo target probabile per liquidity grab al rialzo
    ssl_below:  sslBelow,    // zone sotto: prezzo target probabile per liquidity grab al ribasso
    target_up: targetUp,     // più probabile target di un push rialzista
    target_down: targetDown, // più probabile target di un push ribassista
    last_close: lastClose,
  }
}

export function summarizeLiquidity(liq) {
  if (!liq) return null
  return {
    bsl_above:    liq.bsl_above.slice(0, 3),
    ssl_below:    liq.ssl_below.slice(0, 3),
    most_likely_target_up:   liq.target_up,
    most_likely_target_down: liq.target_down,
  }
}
