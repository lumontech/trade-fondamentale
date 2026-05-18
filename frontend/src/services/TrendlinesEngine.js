// TrendlinesEngine — detection automatica di trendlines significative.
// Costruisce linee connettendo swing highs (resistenze) o swing lows (supporti)
// e valida con third touch (regola classica di Tom Bulkowski).

function findSwings(candles, lookback = 3) {
  const highs = [], lows = []
  for (let i = lookback; i < candles.length - lookback; i++) {
    const c = candles[i]
    let isHigh = true, isLow = true
    for (let j = 1; j <= lookback; j++) {
      if (candles[i - j].high >= c.high || candles[i + j].high >= c.high) isHigh = false
      if (candles[i - j].low  <= c.low  || candles[i + j].low  <= c.low)  isLow  = false
    }
    if (isHigh) highs.push({ index: i, price: c.high, time: c.time })
    if (isLow)  lows.push ({ index: i, price: c.low,  time: c.time })
  }
  return { highs, lows }
}

// Calcola la trendline tra 2 punti e conta i touches
function buildTrendline(p1, p2, candles, type = 'resistance', tolerance = 0.002) {
  const slope = (p2.price - p1.price) / Math.max(1, p2.index - p1.index)
  const touches = [{ ...p1 }, { ...p2 }]
  const violations = []

  // Cerca touches successivi alla seconda candela e violazioni
  for (let i = p2.index + 1; i < candles.length; i++) {
    const expected = p2.price + slope * (i - p2.index)
    const actual   = type === 'resistance' ? candles[i].high : candles[i].low
    const tol = expected * tolerance

    if (Math.abs(actual - expected) <= tol) {
      touches.push({ index: i, price: actual, time: candles[i].time })
    }
    // Violazione se prezzo rompe trendline significativamente
    if (type === 'resistance' && candles[i].close > expected + tol * 2) {
      violations.push({ index: i, price: candles[i].close, time: candles[i].time })
    }
    if (type === 'support' && candles[i].close < expected - tol * 2) {
      violations.push({ index: i, price: candles[i].close, time: candles[i].time })
    }
  }

  return { slope, touches, violations, p1, p2, type }
}

/**
 * Detect le trendline più significative.
 * @returns {Array} trendlines ordinate per quality (touches × age)
 */
export function detectTrendlines(candles, lookback = 100, minTouches = 3) {
  if (!candles || candles.length < 30) return []
  const slice = candles.slice(-lookback)
  const offset = candles.length - slice.length
  const swings = findSwings(slice, 3)

  const trendlines = []

  // RESISTANCE TRENDLINES (connetti swing highs)
  for (let i = 0; i < swings.highs.length - 1; i++) {
    for (let j = i + 1; j < swings.highs.length; j++) {
      const tl = buildTrendline(swings.highs[i], swings.highs[j], slice, 'resistance')
      // Solo trendlines valide: ≥3 touches, non già rotte (o appena rotte)
      if (tl.touches.length >= minTouches) {
        trendlines.push(tl)
      }
    }
  }

  // SUPPORT TRENDLINES (connetti swing lows)
  for (let i = 0; i < swings.lows.length - 1; i++) {
    for (let j = i + 1; j < swings.lows.length; j++) {
      const tl = buildTrendline(swings.lows[i], swings.lows[j], slice, 'support')
      if (tl.touches.length >= minTouches) {
        trendlines.push(tl)
      }
    }
  }

  // Score: più touches + meno tempo dall'ultimo touch + meno violazioni
  const scored = trendlines.map(tl => {
    const lastTouch = tl.touches[tl.touches.length - 1]
    const ageBars = slice.length - 1 - lastTouch.index
    const score = tl.touches.length * 10 - ageBars * 0.3 - tl.violations.length * 5
    return { ...tl, score, ageBars, lastTouchIndex: lastTouch.index + offset }
  }).sort((a, b) => b.score - a.score)

  // Dedup: rimuovi trendlines quasi identiche (slope simile + same type)
  const unique = []
  for (const tl of scored) {
    const dup = unique.find(u =>
      u.type === tl.type &&
      Math.abs(u.slope - tl.slope) / (Math.abs(tl.slope) + 0.0001) < 0.15 &&
      Math.abs(u.p1.index - tl.p1.index) < 5
    )
    if (!dup) unique.push(tl)
  }

  // Top 5 (3 resistance, 2 support o meglio)
  return unique.slice(0, 6).map(tl => {
    const last = candles[candles.length - 1]
    const projectedPrice = tl.p2.price + tl.slope * (candles.length - 1 - (tl.p2.index + offset))
    const distancePct = ((projectedPrice - last.close) / last.close) * 100
    return {
      type:        tl.type,
      slope:       tl.slope,
      direction:   tl.slope > 0 ? 'rising' : tl.slope < 0 ? 'falling' : 'flat',
      touches:     tl.touches.length,
      violations:  tl.violations.length,
      projected_price: projectedPrice,
      distance_pct: distancePct,
      strength:    tl.touches.length >= 5 ? 'major' : tl.touches.length >= 4 ? 'medium' : 'minor',
      // Per disegno sul chart
      from_time:   tl.p1.time,
      from_price:  tl.p1.price,
      to_time:     candles[candles.length - 1].time,
      to_price:    projectedPrice,
      broken:      tl.violations.length > 1,
    }
  })
}

// Sintesi compatta per ContextPack
export function summarizeTrendlines(trendlines) {
  if (!trendlines || trendlines.length === 0) return null
  const r = (n) => Math.round(n * 100000) / 100000
  return {
    count: trendlines.length,
    nearest_resistance: trendlines
      .filter(t => t.type === 'resistance' && t.distance_pct > 0)
      .sort((a, b) => a.distance_pct - b.distance_pct)[0]
        ? {
            price:    r(trendlines.filter(t => t.type === 'resistance' && t.distance_pct > 0)
                          .sort((a, b) => a.distance_pct - b.distance_pct)[0].projected_price),
            distance: Math.round(trendlines.filter(t => t.type === 'resistance' && t.distance_pct > 0)
                          .sort((a, b) => a.distance_pct - b.distance_pct)[0].distance_pct * 100) / 100,
            touches:  trendlines.filter(t => t.type === 'resistance' && t.distance_pct > 0)
                          .sort((a, b) => a.distance_pct - b.distance_pct)[0].touches,
          } : null,
    nearest_support: trendlines
      .filter(t => t.type === 'support' && t.distance_pct < 0)
      .sort((a, b) => b.distance_pct - a.distance_pct)[0]
        ? {
            price:    r(trendlines.filter(t => t.type === 'support' && t.distance_pct < 0)
                          .sort((a, b) => b.distance_pct - a.distance_pct)[0].projected_price),
            distance: Math.round(trendlines.filter(t => t.type === 'support' && t.distance_pct < 0)
                          .sort((a, b) => b.distance_pct - a.distance_pct)[0].distance_pct * 100) / 100,
            touches:  trendlines.filter(t => t.type === 'support' && t.distance_pct < 0)
                          .sort((a, b) => b.distance_pct - a.distance_pct)[0].touches,
          } : null,
    all: trendlines.map(t => ({
      type:     t.type,
      direction: t.direction,
      strength: t.strength,
      touches:  t.touches,
      projected_price: r(t.projected_price),
      distance_pct: Math.round(t.distance_pct * 100) / 100,
      broken:   t.broken,
    })),
  }
}
