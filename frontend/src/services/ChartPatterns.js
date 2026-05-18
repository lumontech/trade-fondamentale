// Chart Patterns — pattern multi-candela basati su swing detection.
// Detection di Double Top/Bottom, Head & Shoulders, Triangle, Wedge, Flag.

// Trova swing highs e lows con confirmation
function findSwings(candles, lookback = 3) {
  const highs = []
  const lows = []
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

/**
 * Restituisce chart patterns detectati nelle ultime ~100 candele.
 */
export function detectChartPatterns(candles, lookback = 100) {
  if (!candles || candles.length < 50) return []
  const slice = candles.slice(-lookback)
  const offset = candles.length - slice.length
  const swings = findSwings(slice, 3)
  const patterns = []

  // Tolleranza prezzo per "stesso livello" (basata su ATR semplificato)
  let atr = 0
  for (let i = slice.length - 14; i < slice.length; i++) {
    if (i > 0) atr += Math.abs(slice[i].high - slice[i].low)
  }
  atr /= 14

  // ── DOUBLE TOP ────────────────────────────────────────────────
  // Due high a stesso livello, intervallati da un low
  const highs = swings.highs
  for (let i = 1; i < highs.length; i++) {
    const h1 = highs[i - 1]
    const h2 = highs[i]
    const distance = h2.index - h1.index
    if (distance < 5 || distance > 50) continue
    if (Math.abs(h1.price - h2.price) > atr * 0.6) continue

    // Cerca low intermedio (neckline)
    const between = swings.lows.filter(l => l.index > h1.index && l.index < h2.index)
    if (between.length === 0) continue
    const neckline = Math.min(...between.map(l => l.price))
    const lastClose = slice[slice.length - 1].close

    patterns.push({
      type: 'chart', name: 'Double Top', italian: 'Doppio Massimo',
      bias: 'bearish',
      reliability: lastClose < neckline ? 'high' : 'medium',
      candleIndex: offset + h2.index,
      time: h2.time,
      level: h2.price,
      neckline,
      target: neckline - (h2.price - neckline),  // misura: altezza pattern proiettata sotto
      description: `Due massimi a livello ${h1.price.toFixed(5)} - ${h2.price.toFixed(5)}. Neckline ${neckline.toFixed(5)}. Conferma su rottura neckline.`,
      confirmed: lastClose < neckline,
    })
  }

  // ── DOUBLE BOTTOM ─────────────────────────────────────────────
  const lows = swings.lows
  for (let i = 1; i < lows.length; i++) {
    const l1 = lows[i - 1]
    const l2 = lows[i]
    const distance = l2.index - l1.index
    if (distance < 5 || distance > 50) continue
    if (Math.abs(l1.price - l2.price) > atr * 0.6) continue
    const between = swings.highs.filter(h => h.index > l1.index && h.index < l2.index)
    if (between.length === 0) continue
    const neckline = Math.max(...between.map(h => h.price))
    const lastClose = slice[slice.length - 1].close

    patterns.push({
      type: 'chart', name: 'Double Bottom', italian: 'Doppio Minimo',
      bias: 'bullish',
      reliability: lastClose > neckline ? 'high' : 'medium',
      candleIndex: offset + l2.index,
      time: l2.time,
      level: l2.price,
      neckline,
      target: neckline + (neckline - l2.price),
      description: `Due minimi a livello ${l1.price.toFixed(5)} - ${l2.price.toFixed(5)}. Neckline ${neckline.toFixed(5)}. Conferma su rottura neckline.`,
      confirmed: lastClose > neckline,
    })
  }

  // ── HEAD & SHOULDERS ──────────────────────────────────────────
  // 3 swing highs: il centrale (head) più alto delle 2 spalle
  for (let i = 2; i < highs.length; i++) {
    const ls = highs[i - 2]
    const head = highs[i - 1]
    const rs = highs[i]
    if (head.price <= ls.price || head.price <= rs.price) continue
    if (Math.abs(ls.price - rs.price) > atr * 0.8) continue
    const distance = rs.index - ls.index
    if (distance < 8 || distance > 60) continue
    // Neckline = min dei due low tra le spalle e la head
    const lowsBetween = swings.lows.filter(l => l.index > ls.index && l.index < rs.index)
    if (lowsBetween.length < 2) continue
    const neckline = Math.min(...lowsBetween.map(l => l.price))
    const lastClose = slice[slice.length - 1].close

    patterns.push({
      type: 'chart', name: 'Head & Shoulders', italian: 'Testa e Spalle',
      bias: 'bearish', reliability: 'high',
      candleIndex: offset + rs.index, time: rs.time,
      level: head.price,
      neckline,
      target: neckline - (head.price - neckline),
      description: `Spalla SX ${ls.price.toFixed(5)} - Testa ${head.price.toFixed(5)} - Spalla DX ${rs.price.toFixed(5)}. Reversal classico.`,
      confirmed: lastClose < neckline,
    })
  }

  // ── INVERSE HEAD & SHOULDERS ─────────────────────────────────
  for (let i = 2; i < lows.length; i++) {
    const ls = lows[i - 2]
    const head = lows[i - 1]
    const rs = lows[i]
    if (head.price >= ls.price || head.price >= rs.price) continue
    if (Math.abs(ls.price - rs.price) > atr * 0.8) continue
    const distance = rs.index - ls.index
    if (distance < 8 || distance > 60) continue
    const highsBetween = swings.highs.filter(h => h.index > ls.index && h.index < rs.index)
    if (highsBetween.length < 2) continue
    const neckline = Math.max(...highsBetween.map(h => h.price))
    const lastClose = slice[slice.length - 1].close

    patterns.push({
      type: 'chart', name: 'Inverse Head & Shoulders', italian: 'Testa e Spalle Inversa',
      bias: 'bullish', reliability: 'high',
      candleIndex: offset + rs.index, time: rs.time,
      level: head.price,
      neckline,
      target: neckline + (neckline - head.price),
      description: `Spalla SX ${ls.price.toFixed(5)} - Testa ${head.price.toFixed(5)} - Spalla DX ${rs.price.toFixed(5)}. Reversal bullish classico.`,
      confirmed: lastClose > neckline,
    })
  }

  // ── TRIANGLE (Ascending / Descending / Symmetric) ─────────────
  // Almeno 2 high e 2 low recenti, con trend convergente
  if (highs.length >= 2 && lows.length >= 2) {
    const lastHighs = highs.slice(-3)
    const lastLows  = lows.slice(-3)
    if (lastHighs.length >= 2 && lastLows.length >= 2) {
      const h1 = lastHighs[0], h2 = lastHighs[lastHighs.length - 1]
      const l1 = lastLows[0],  l2 = lastLows[lastLows.length - 1]
      const highSlope = (h2.price - h1.price) / Math.max(1, h2.index - h1.index)
      const lowSlope  = (l2.price - l1.price) / Math.max(1, l2.index - l1.index)
      const flatTol = atr * 0.05

      let triangleType = null
      if (Math.abs(highSlope) < flatTol && lowSlope > flatTol) {
        triangleType = { name: 'Ascending Triangle', italian: 'Triangolo Ascendente', bias: 'bullish' }
      } else if (Math.abs(lowSlope) < flatTol && highSlope < -flatTol) {
        triangleType = { name: 'Descending Triangle', italian: 'Triangolo Discendente', bias: 'bearish' }
      } else if (highSlope < -flatTol && lowSlope > flatTol) {
        triangleType = { name: 'Symmetric Triangle', italian: 'Triangolo Simmetrico', bias: 'neutral' }
      }
      if (triangleType) {
        patterns.push({
          type: 'chart', ...triangleType,
          reliability: 'medium',
          candleIndex: offset + Math.max(h2.index, l2.index),
          time: slice[Math.max(h2.index, l2.index)].time,
          description: `Resistenza ${h2.price.toFixed(5)}, supporto ${l2.price.toFixed(5)}. Compressione: rottura = trigger.`,
        })
      }
    }
  }

  // ── RISING / FALLING WEDGE ────────────────────────────────────
  // Higher highs + higher lows che convergono (rising wedge = bearish)
  if (highs.length >= 3 && lows.length >= 3) {
    const lastHighs = highs.slice(-3)
    const lastLows  = lows.slice(-3)
    const hh = lastHighs[0].price < lastHighs[1].price && lastHighs[1].price < lastHighs[2].price
    const hl = lastLows[0].price < lastLows[1].price && lastLows[1].price < lastLows[2].price
    const lh = lastHighs[0].price > lastHighs[1].price && lastHighs[1].price > lastHighs[2].price
    const ll = lastLows[0].price > lastLows[1].price && lastLows[1].price > lastLows[2].price
    const highSlope = (lastHighs[2].price - lastHighs[0].price) / Math.max(1, lastHighs[2].index - lastHighs[0].index)
    const lowSlope  = (lastLows[2].price  - lastLows[0].price)  / Math.max(1, lastLows[2].index  - lastLows[0].index)

    if (hh && hl && lowSlope > highSlope) {
      patterns.push({
        type: 'chart', name: 'Rising Wedge', italian: 'Cuneo Ascendente',
        bias: 'bearish', reliability: 'medium',
        candleIndex: offset + lastHighs[2].index, time: lastHighs[2].time,
        description: 'HH e HL convergenti dal basso (cuneo). Tipicamente bearish reversal in uptrend stanco.',
      })
    } else if (lh && ll && highSlope < lowSlope) {
      patterns.push({
        type: 'chart', name: 'Falling Wedge', italian: 'Cuneo Discendente',
        bias: 'bullish', reliability: 'medium',
        candleIndex: offset + lastLows[2].index, time: lastLows[2].time,
        description: 'LH e LL convergenti dall\'alto (cuneo). Tipicamente bullish reversal in downtrend stanco.',
      })
    }
  }

  return patterns
}
