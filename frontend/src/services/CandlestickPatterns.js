// Candlestick Patterns — detection di pattern 1-3 candele.
// Focus sui pattern PIÙ AFFIDABILI per forex/oro/indici secondo letteratura
// (Bulkowski "Encyclopedia of Candlestick Charts", studi accademici sui maggiori).

// Helper: anatomia di una candela
function anatomy(c) {
  const body = Math.abs(c.close - c.open)
  const range = c.high - c.low
  const upperWick = c.high - Math.max(c.open, c.close)
  const lowerWick = Math.min(c.open, c.close) - c.low
  return {
    body, range, upperWick, lowerWick,
    bodyPct: range > 0 ? body / range : 0,
    upperPct: range > 0 ? upperWick / range : 0,
    lowerPct: range > 0 ? lowerWick / range : 0,
    bullish: c.close > c.open,
    bearish: c.close < c.open,
    midpoint: (c.open + c.close) / 2,
  }
}

// ATR semplificato per calibrare significatività body
function avgBody(candles, period = 14) {
  const n = Math.min(period, candles.length)
  let sum = 0
  for (let i = candles.length - n; i < candles.length; i++) {
    sum += Math.abs(candles[i].close - candles[i].open)
  }
  return sum / n
}

/**
 * Restituisce pattern detectati nelle ultime N candele (default 30).
 * Ogni pattern: { type, name, italian, candleIndex, time, bias, reliability, description }
 */
export function detectCandlestickPatterns(candles, lookback = 30) {
  if (!candles || candles.length < 3) return []
  const patterns = []
  const start = Math.max(2, candles.length - lookback)
  const avgB = avgBody(candles, 20)
  if (avgB <= 0) return []

  for (let i = start; i < candles.length; i++) {
    const c = candles[i]
    const prev = candles[i - 1]
    const prev2 = candles[i - 2]
    const a = anatomy(c)
    const ap = anatomy(prev)

    // ── BULLISH ENGULFING ──────────────────────────────────────────
    // Forte affidabilità su forex 1h+. Closure bullish che inghiotte body bearish precedente.
    if (
      ap.bearish && a.bullish &&
      c.open <= prev.close && c.close >= prev.open &&
      a.body > avgB * 0.8
    ) {
      patterns.push({
        type: 'candlestick', name: 'Bullish Engulfing', italian: 'Engulfing Rialzista',
        candleIndex: i, time: c.time, bias: 'bullish', reliability: 'high',
        description: 'La candela rialzista inghiotte completamente quella ribassista precedente. Forte segnale di reversal in supporto.',
      })
    }

    // ── BEARISH ENGULFING ─────────────────────────────────────────
    if (
      ap.bullish && a.bearish &&
      c.open >= prev.close && c.close <= prev.open &&
      a.body > avgB * 0.8
    ) {
      patterns.push({
        type: 'candlestick', name: 'Bearish Engulfing', italian: 'Engulfing Ribassista',
        candleIndex: i, time: c.time, bias: 'bearish', reliability: 'high',
        description: 'La candela ribassista inghiotte completamente quella rialzista precedente. Forte segnale di reversal in resistenza.',
      })
    }

    // ── HAMMER (in downtrend) ─────────────────────────────────────
    // Wick inferiore lungo (>2x body), upper wick piccolo, in zona di supporto
    if (
      a.lowerPct > 0.5 && a.upperPct < 0.15 && a.bodyPct < 0.4 &&
      a.body > avgB * 0.2
    ) {
      // Verifica downtrend recente: chiusure precedenti in calo
      const recentTrend = i >= 5 ? candles[i - 1].close - candles[i - 5].close : 0
      if (recentTrend < 0) {
        patterns.push({
          type: 'candlestick', name: 'Hammer', italian: 'Martello',
          candleIndex: i, time: c.time, bias: 'bullish', reliability: 'medium',
          description: 'Ombra inferiore lunga in downtrend: i compratori hanno respinto un push ribassista. Reversal probabile su supporto.',
        })
      }
    }

    // ── SHOOTING STAR (in uptrend) ────────────────────────────────
    if (
      a.upperPct > 0.5 && a.lowerPct < 0.15 && a.bodyPct < 0.4 &&
      a.body > avgB * 0.2
    ) {
      const recentTrend = i >= 5 ? candles[i - 1].close - candles[i - 5].close : 0
      if (recentTrend > 0) {
        patterns.push({
          type: 'candlestick', name: 'Shooting Star', italian: 'Stella Cadente',
          candleIndex: i, time: c.time, bias: 'bearish', reliability: 'medium',
          description: 'Ombra superiore lunga in uptrend: i venditori hanno respinto un push rialzista. Reversal probabile su resistenza.',
        })
      }
    }

    // ── DOJI (indecisione) ────────────────────────────────────────
    if (a.bodyPct < 0.1 && a.range > avgB * 0.5) {
      let dojiType = 'Doji'
      let italian = 'Doji (indecisione)'
      if (a.lowerPct > 0.6) { dojiType = 'Dragonfly Doji'; italian = 'Dragonfly Doji' }
      if (a.upperPct > 0.6) { dojiType = 'Gravestone Doji'; italian = 'Gravestone Doji' }
      patterns.push({
        type: 'candlestick', name: dojiType, italian,
        candleIndex: i, time: c.time, bias: 'neutral', reliability: 'low',
        description: 'Equilibrio tra compratori e venditori. Da solo non è un trigger; in confluenza con S/R è significativo.',
      })
    }

    // ── PIN BAR (in trend o S/R) ──────────────────────────────────
    // Mecha lunga in una direzione, body piccolo all'estremità opposta
    if (a.bodyPct < 0.3 && a.body > avgB * 0.15) {
      if (a.lowerPct > 0.6 && a.upperPct < 0.15) {
        patterns.push({
          type: 'candlestick', name: 'Bullish Pin Bar', italian: 'Pin Bar Rialzista',
          candleIndex: i, time: c.time, bias: 'bullish', reliability: 'high',
          description: 'Coda lunga al ribasso seguita da chiusura sui massimi. Setup retail molto seguito su supporti chiave.',
        })
      } else if (a.upperPct > 0.6 && a.lowerPct < 0.15) {
        patterns.push({
          type: 'candlestick', name: 'Bearish Pin Bar', italian: 'Pin Bar Ribassista',
          candleIndex: i, time: c.time, bias: 'bearish', reliability: 'high',
          description: 'Coda lunga al rialzo seguita da chiusura sui minimi. Setup retail molto seguito su resistenze chiave.',
        })
      }
    }

    // ── INSIDE BAR (compressione, breakout pending) ───────────────
    if (i >= 1 && c.high < prev.high && c.low > prev.low) {
      patterns.push({
        type: 'candlestick', name: 'Inside Bar', italian: 'Inside Bar',
        candleIndex: i, time: c.time, bias: 'neutral', reliability: 'medium',
        description: 'Range più stretto della candela precedente. Compressione: rottura sopra max o sotto min della madre = trigger.',
      })
    }

    // ── MORNING STAR (3 candele bullish reversal) ─────────────────
    if (i >= 2) {
      const a2 = anatomy(prev2)
      // 1) bearish forte 2) small body 3) bullish forte che chiude oltre metà di 1)
      if (
        a2.bearish && a2.body > avgB * 0.7 &&
        ap.body < avgB * 0.4 &&
        a.bullish && a.body > avgB * 0.7 &&
        c.close > a2.midpoint
      ) {
        patterns.push({
          type: 'candlestick', name: 'Morning Star', italian: 'Stella del Mattino',
          candleIndex: i, time: c.time, bias: 'bullish', reliability: 'high',
          description: '3 candele: drop forte, small body indeciso, recovery bullish forte. Reversal classico molto affidabile.',
        })
      }
      // EVENING STAR (specchio)
      if (
        a2.bullish && a2.body > avgB * 0.7 &&
        ap.body < avgB * 0.4 &&
        a.bearish && a.body > avgB * 0.7 &&
        c.close < a2.midpoint
      ) {
        patterns.push({
          type: 'candlestick', name: 'Evening Star', italian: 'Stella della Sera',
          candleIndex: i, time: c.time, bias: 'bearish', reliability: 'high',
          description: '3 candele: rally forte, small body indeciso, drop bearish forte. Reversal classico molto affidabile.',
        })
      }
    }

    // ── TWEEZER TOP / BOTTOM (doppio touch a livello) ─────────────
    if (i >= 1) {
      const tolerance = avgB * 0.15
      if (Math.abs(c.high - prev.high) < tolerance && ap.bullish && a.bearish) {
        patterns.push({
          type: 'candlestick', name: 'Tweezer Top', italian: 'Tweezer Top',
          candleIndex: i, time: c.time, bias: 'bearish', reliability: 'medium',
          description: 'Due candele con stesso high ma chiusura opposta. Resistenza confermata, possibile reversal.',
        })
      }
      if (Math.abs(c.low - prev.low) < tolerance && ap.bearish && a.bullish) {
        patterns.push({
          type: 'candlestick', name: 'Tweezer Bottom', italian: 'Tweezer Bottom',
          candleIndex: i, time: c.time, bias: 'bullish', reliability: 'medium',
          description: 'Due candele con stesso low ma chiusura opposta. Supporto confermato, possibile reversal.',
        })
      }
    }
  }

  // ── DOJI (4 varianti) — bar i = ultima ────────────────────────────
  for (let i = start; i < candles.length; i++) {
    const c = candles[i]
    const a = anatomy(c)
    if (a.bodyPct > 0.10) continue   // body < 10% range = doji
    // Standard Doji
    const isLongLegged = a.upperPct > 0.4 && a.lowerPct > 0.4
    const isDragonfly  = a.lowerPct > 0.6 && a.upperPct < 0.1
    const isGravestone = a.upperPct > 0.6 && a.lowerPct < 0.1
    if (isDragonfly) {
      patterns.push({
        type: 'candlestick', name: 'Dragonfly Doji', italian: 'Doji a Libellula',
        candleIndex: i, time: c.time, bias: 'bullish', reliability: 'medium',
        description: 'Doji con lunga ombra inferiore e quasi nessuna superiore. Rejection del low, possibile reversal bullish.',
      })
    } else if (isGravestone) {
      patterns.push({
        type: 'candlestick', name: 'Gravestone Doji', italian: 'Doji Pietra Tombale',
        candleIndex: i, time: c.time, bias: 'bearish', reliability: 'medium',
        description: 'Doji con lunga ombra superiore e quasi nessuna inferiore. Rejection del high, possibile reversal bearish.',
      })
    } else if (isLongLegged) {
      patterns.push({
        type: 'candlestick', name: 'Long-Legged Doji', italian: 'Doji a Gambe Lunghe',
        candleIndex: i, time: c.time, bias: 'neutral', reliability: 'low',
        description: 'Doji con ombre lunghe su entrambi i lati. Indecisione massima, attendi conferma.',
      })
    }
  }

  // ── THREE WHITE SOLDIERS / THREE BLACK CROWS (3 candele) ──────────
  for (let i = Math.max(start, 2); i < candles.length; i++) {
    const c1 = candles[i-2], c2 = candles[i-1], c3 = candles[i]
    const a1 = anatomy(c1), a2 = anatomy(c2), a3 = anatomy(c3)
    // Three White Soldiers: 3 bullish progressive con bodies grandi
    if (a1.bullish && a2.bullish && a3.bullish &&
        a1.body > avgB * 0.6 && a2.body > avgB * 0.6 && a3.body > avgB * 0.6 &&
        c2.close > c1.close && c3.close > c2.close &&
        c2.open > c1.open && c2.open < c1.close &&
        c3.open > c2.open && c3.open < c2.close) {
      patterns.push({
        type: 'candlestick', name: 'Three White Soldiers', italian: 'Tre Soldati Bianchi',
        candleIndex: i, time: c3.time, bias: 'bullish', reliability: 'high',
        description: 'Tre candele rialziste consecutive con close progressivamente piu alti. Forte segnale di continuation/reversal bullish.',
      })
    }
    // Three Black Crows: 3 bearish progressive
    if (a1.bearish && a2.bearish && a3.bearish &&
        a1.body > avgB * 0.6 && a2.body > avgB * 0.6 && a3.body > avgB * 0.6 &&
        c2.close < c1.close && c3.close < c2.close &&
        c2.open < c1.open && c2.open > c1.close &&
        c3.open < c2.open && c3.open > c2.close) {
      patterns.push({
        type: 'candlestick', name: 'Three Black Crows', italian: 'Tre Corvi Neri',
        candleIndex: i, time: c3.time, bias: 'bearish', reliability: 'high',
        description: 'Tre candele ribassiste consecutive con close progressivamente piu bassi. Forte continuation bearish.',
      })
    }
  }

  // ── HARAMI (2 candele): bar 0 grande, bar 1 inside dentro il body ─
  for (let i = Math.max(start, 1); i < candles.length; i++) {
    const p = candles[i-1], c = candles[i]
    const ap = anatomy(p), ac = anatomy(c)
    if (ap.body < avgB * 0.8) continue   // mother bar deve essere grande
    // Bullish Harami: prev bearish, current bullish piccola dentro body precedente
    if (ap.bearish && ac.bullish &&
        c.high <= p.open && c.low >= p.close &&
        ac.body < ap.body * 0.5) {
      patterns.push({
        type: 'candlestick', name: 'Bullish Harami', italian: 'Harami Rialzista',
        candleIndex: i, time: c.time, bias: 'bullish', reliability: 'medium',
        description: 'Candela bullish piccola contenuta dentro body bearish grande precedente. Possibile reversal.',
      })
    }
    if (ap.bullish && ac.bearish &&
        c.high <= p.close && c.low >= p.open &&
        ac.body < ap.body * 0.5) {
      patterns.push({
        type: 'candlestick', name: 'Bearish Harami', italian: 'Harami Ribassista',
        candleIndex: i, time: c.time, bias: 'bearish', reliability: 'medium',
        description: 'Candela bearish piccola dentro body bullish grande precedente. Possibile reversal.',
      })
    }
  }

  // ── PIERCING LINE / DARK CLOUD COVER (2 candele) ──────────────────
  for (let i = Math.max(start, 1); i < candles.length; i++) {
    const p = candles[i-1], c = candles[i]
    const ap = anatomy(p), ac = anatomy(c)
    if (ap.body < avgB * 0.7) continue
    // Piercing Line: bear forte + bull che apre sotto e chiude OLTRE midpoint precedente
    if (ap.bearish && ac.bullish &&
        c.open < p.low && c.close > ap.midpoint && c.close < p.open) {
      patterns.push({
        type: 'candlestick', name: 'Piercing Line', italian: 'Linea di Penetrazione',
        candleIndex: i, time: c.time, bias: 'bullish', reliability: 'high',
        description: 'Candela bullish che apre sotto il low precedente e chiude oltre meta del body bearish. Reversal forte.',
      })
    }
    // Dark Cloud Cover: opposto
    if (ap.bullish && ac.bearish &&
        c.open > p.high && c.close < ap.midpoint && c.close > p.open) {
      patterns.push({
        type: 'candlestick', name: 'Dark Cloud Cover', italian: 'Copertura di Nubi Scure',
        candleIndex: i, time: c.time, bias: 'bearish', reliability: 'high',
        description: 'Candela bearish che apre sopra il high precedente e chiude oltre meta del body bullish. Reversal forte.',
      })
    }
  }

  // ── HANGING MAN / INVERTED HAMMER ─────────────────────────────────
  // Stessa anatomia di Hammer/Shooting Star ma in posizione "sbagliata" (al top dopo trend up = bearish)
  for (let i = Math.max(start, 5); i < candles.length; i++) {
    const c = candles[i]
    const a = anatomy(c)
    if (a.body > avgB * 0.6) continue
    // Trend recente: ultime 5 candele
    let recentTrend = 0
    for (let j = Math.max(0, i - 5); j < i; j++) {
      recentTrend += candles[j].close - candles[j].open
    }
    // Hanging Man: corpo piccolo + lunga ombra inferiore, in posizione di top
    if (a.lowerPct > 0.6 && a.upperPct < 0.15 && recentTrend > 0) {
      patterns.push({
        type: 'candlestick', name: 'Hanging Man', italian: 'Uomo Impiccato',
        candleIndex: i, time: c.time, bias: 'bearish', reliability: 'medium',
        description: 'Stessa anatomia dell\'Hammer ma in fase di uptrend. Segnale di possibile reversal bearish.',
      })
    }
    // Inverted Hammer: in fase di downtrend, possibile reversal bullish
    if (a.upperPct > 0.6 && a.lowerPct < 0.15 && recentTrend < 0) {
      patterns.push({
        type: 'candlestick', name: 'Inverted Hammer', italian: 'Martello Invertito',
        candleIndex: i, time: c.time, bias: 'bullish', reliability: 'medium',
        description: 'Corpo piccolo con lunga ombra superiore in fase di downtrend. Possibile reversal bullish.',
      })
    }
  }

  return patterns
}
