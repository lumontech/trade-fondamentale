// Harmonic Patterns — Gartley, Bat, Cypher, Butterfly, Crab.
// Pattern XABCD basati su Fibonacci ratios. Tra i più precisi su forex/oro
// quando presenti — alta affidabilità statistica nei punti D (PRZ).
//
// Riferimento: Scott Carney "Harmonic Trading" + ricerche su EUR/USD, XAU/USD.

const TOL = 0.10    // Tolleranza ±10% sui rapporti Fibonacci (era 5%, troppo stretto)

// Specifica Fibonacci per ogni pattern (riferimento Scott Carney)
// AB/XA, BC/AB, CD/BC, AD/XA
const HARMONIC_SPECS = {
  Gartley: {
    italian: 'Gartley',
    AB_XA: [0.618, 0.618],            // = 0.618 esatto
    BC_AB: [0.382, 0.886],            // 0.382 - 0.886
    CD_BC: [1.13, 1.618],             // 1.13 - 1.618
    AD_XA: [0.786, 0.786],            // = 0.786 esatto (PRZ)
    description: 'Pattern reversal classico. D al 78.6% di XA. Setup molto seguito da trader istituzionali.',
  },
  Bat: {
    italian: 'Bat',
    AB_XA: [0.382, 0.50],
    BC_AB: [0.382, 0.886],
    CD_BC: [1.618, 2.618],
    AD_XA: [0.886, 0.886],            // PRZ profondo
    description: 'Reversal pattern con D al 88.6% di XA (più profondo del Gartley). Fra i più affidabili statisticamente.',
  },
  Cypher: {
    italian: 'Cypher',
    AB_XA: [0.382, 0.618],
    BC_AB: [1.13, 1.414],             // BC ESTENDE oltre A
    CD_BC: [null, null],               // Cypher usa AD/XC, non CD/BC
    AD_XC: [0.786, 0.786],            // D al 78.6% di XC (NON XA)
    description: 'Pattern moderno (Darren Oglesbee). BC estende oltre A. D al 78.6% di XC. Studiato come uno dei più precisi su forex.',
    isCypher: true,
  },
  Butterfly: {
    italian: 'Butterfly',
    AB_XA: [0.786, 0.786],
    BC_AB: [0.382, 0.886],
    CD_BC: [1.618, 2.618],
    AD_XA: [1.27, 1.618],             // EXTENSION oltre X
    description: 'D estende oltre il punto X (1.27-1.618). Reversal pattern alle estremità di trend forti.',
  },
  Crab: {
    italian: 'Crab',
    AB_XA: [0.382, 0.618],
    BC_AB: [0.382, 0.886],
    CD_BC: [2.618, 3.618],
    AD_XA: [1.618, 1.618],            // EXTENSION estrema
    description: 'Pattern di estensione estrema. D al 161.8% di XA. Il più aggressivo dei pattern Carney.',
  },
}

function inRange(value, [min, max]) {
  if (min === null || max === null) return false
  return value >= min * (1 - TOL) && value <= max * (1 + TOL)
}

// Trova swing points alternati (high-low-high-low...)
function findAlternatingSwings(candles, lookback = 2) {
  const swings = []
  for (let i = lookback; i < candles.length - lookback; i++) {
    const c = candles[i]
    let isHigh = true, isLow = true
    for (let j = 1; j <= lookback; j++) {
      if (candles[i - j].high >= c.high || candles[i + j].high >= c.high) isHigh = false
      if (candles[i - j].low  <= c.low  || candles[i + j].low  <= c.low)  isLow  = false
    }
    if (isHigh) swings.push({ index: i, price: c.high, type: 'high', time: c.time })
    else if (isLow) swings.push({ index: i, price: c.low, type: 'low', time: c.time })
  }
  // Filtra: rimuovi swing consecutivi dello stesso tipo (tieni il più estremo)
  const filtered = []
  for (const s of swings) {
    const last = filtered[filtered.length - 1]
    if (!last || last.type !== s.type) {
      filtered.push(s)
    } else {
      // Stesso tipo: aggiorna se più estremo
      if (s.type === 'high' && s.price > last.price) filtered[filtered.length - 1] = s
      if (s.type === 'low'  && s.price < last.price) filtered[filtered.length - 1] = s
    }
  }
  return filtered
}

/**
 * Verifica se 5 swing points alternati formano un pattern armonico.
 * @param {Array} pts - [X, A, B, C, D] alternated swing points
 * @param {Object} spec - HARMONIC_SPECS entry
 * @returns {Object|null} dettagli del match, o null
 */
function checkPattern(pts, spec) {
  if (pts.length !== 5) return null
  const [X, A, B, C, D] = pts

  // Check direzione (bullish: X high, A low, B high, C low, D low extreme)
  const isBullish = X.type === 'high' && A.type === 'low' && B.type === 'high' && C.type === 'low' && D.type === 'low'
  const isBearish = X.type === 'low'  && A.type === 'high' && B.type === 'low'  && C.type === 'high' && D.type === 'high'
  if (!isBullish && !isBearish) return null

  const XA = Math.abs(A.price - X.price)
  const AB = Math.abs(B.price - A.price)
  const BC = Math.abs(C.price - B.price)
  const CD = Math.abs(D.price - C.price)
  const AD = Math.abs(D.price - A.price)
  const XC = Math.abs(C.price - X.price)

  const abXa = AB / XA
  const bcAb = BC / AB
  const cdBc = CD / BC
  const adXa = AD / XA
  const adXc = AD / XC

  if (!inRange(abXa, spec.AB_XA)) return null
  if (!inRange(bcAb, spec.BC_AB)) return null

  // Cypher usa AD/XC invece di CD/BC e AD/XA
  if (spec.isCypher) {
    if (!inRange(adXc, spec.AD_XC)) return null
  } else {
    if (!inRange(cdBc, spec.CD_BC)) return null
    if (!inRange(adXa, spec.AD_XA)) return null
  }

  return {
    X, A, B, C, D,
    bias: isBullish ? 'bullish' : 'bearish',
    ratios: {
      AB_XA: Math.round(abXa * 1000) / 1000,
      BC_AB: Math.round(bcAb * 1000) / 1000,
      CD_BC: Math.round(cdBc * 1000) / 1000,
      AD_XA: Math.round(adXa * 1000) / 1000,
      AD_XC: spec.isCypher ? Math.round(adXc * 1000) / 1000 : null,
    },
  }
}

/**
 * AB=CD pattern (3 swing points: A, B, C — D proiettato).
 * CD ha stessa lunghezza di AB (tolleranza 10%), BC retracement di AB (61.8-78.6%).
 * Il piu semplice e frequente dei pattern armonici. Carney lo considera fondamento.
 */
function checkAbCd(pts) {
  if (pts.length !== 4) return null   // A, B, C, D (D = ultimo swing detected)
  const [A, B, C, D] = pts
  // Bullish: A high, B low, C high, D low (D low estremo)
  const isBullish = A.type === 'high' && B.type === 'low' && C.type === 'high' && D.type === 'low'
  const isBearish = A.type === 'low'  && B.type === 'high' && C.type === 'low'  && D.type === 'high'
  if (!isBullish && !isBearish) return null

  const AB = Math.abs(B.price - A.price)
  const BC = Math.abs(C.price - B.price)
  const CD = Math.abs(D.price - C.price)
  if (AB === 0 || BC === 0) return null

  const bcAb = BC / AB
  const cdAb = CD / AB

  // BC retracement 38.2% - 88.6% (range standard)
  if (bcAb < 0.382 - TOL || bcAb > 0.886 + TOL) return null
  // CD = AB ratio: 0.9 - 1.27 (= equality plus 27% extension max)
  if (cdAb < 0.9 - TOL || cdAb > 1.27 + TOL) return null

  return {
    A, B, C, D,
    bias: isBullish ? 'bullish' : 'bearish',
    ratios: {
      BC_AB: Math.round(bcAb * 1000) / 1000,
      CD_AB: Math.round(cdAb * 1000) / 1000,
    },
  }
}

/**
 * Detect harmonic patterns nelle ultime ~150 candele.
 * Considera solo pattern in formazione recente (D negli ultimi 20 bar).
 */
export function detectHarmonicPatterns(candles, lookback = 150) {
  if (!candles || candles.length < 60) return []
  const slice = candles.slice(-lookback)
  const offset = candles.length - slice.length
  const swings = findAlternatingSwings(slice, 3)
  if (swings.length < 5) return []

  const patterns = []
  // Itera su ogni possibile combinazione di 5 swing alternati consecutivi
  for (let i = 0; i <= swings.length - 5; i++) {
    const pts = swings.slice(i, i + 5)
    const D = pts[4]
    // Solo pattern dove il D è negli ultimi 50 bar (recente, attuale)
    if (slice.length - 1 - D.index > 50) continue

    for (const [name, spec] of Object.entries(HARMONIC_SPECS)) {
      const match = checkPattern(pts, spec)
      if (match) {
        // Calcola TP1 (61.8% di CD) e SL (oltre X)
        const D_price = match.D.price
        const A_price = match.A.price
        const C_price = match.C.price
        const X_price = match.X.price
        const isBull = match.bias === 'bullish'
        const tp1 = isBull ? D_price + (A_price - D_price) * 0.382 : D_price - (D_price - A_price) * 0.382
        const tp2 = isBull ? D_price + (A_price - D_price) * 0.618 : D_price - (D_price - A_price) * 0.618
        const sl  = isBull ? Math.min(X_price * 0.998, D_price * 0.995) : Math.max(X_price * 1.002, D_price * 1.005)

        patterns.push({
          type: 'harmonic',
          name,
          italian: spec.italian,
          bias: match.bias,
          reliability: 'high',
          description: spec.description,
          ratios: match.ratios,
          points: { X: match.X, A: match.A, B: match.B, C: match.C, D: match.D },
          prz: D_price,           // Potential Reversal Zone
          tp1, tp2, sl,
          candleIndex: offset + match.D.index,
          time: match.D.time,
        })
      }
    }
  }

  // ── AB=CD detection (3 swings + D) ──────────────────────────────
  for (let i = 0; i <= swings.length - 4; i++) {
    const pts = swings.slice(i, i + 4)
    const D = pts[3]
    if (slice.length - 1 - D.index > 50) continue
    const match = checkAbCd(pts)
    if (match) {
      const isBull = match.bias === 'bullish'
      const D_price = match.D.price
      const A_price = match.A.price
      const tp1 = isBull ? D_price + (A_price - D_price) * 0.382 : D_price - (D_price - A_price) * 0.382
      const tp2 = isBull ? D_price + (A_price - D_price) * 0.618 : D_price - (D_price - A_price) * 0.618
      const sl  = isBull ? D_price * 0.992 : D_price * 1.008
      patterns.push({
        type: 'harmonic',
        name: 'AB=CD',
        italian: 'AB=CD',
        bias: match.bias,
        reliability: 'medium',
        description: 'Pattern armonico fondamentale a 4 punti. CD ha stessa lunghezza di AB. BC retracement 38.2%-88.6%. Il piu frequente.',
        ratios: match.ratios,
        points: match,
        prz: D_price,
        tp1, tp2, sl,
        candleIndex: offset + match.D.index,
        time: match.D.time,
      })
    }
  }

  // Dedup: tieni solo il pattern più recente per ogni name
  const seen = new Set()
  const dedup = []
  for (const p of patterns.sort((a, b) => b.candleIndex - a.candleIndex)) {
    if (!seen.has(p.name)) {
      seen.add(p.name)
      dedup.push(p)
    }
  }
  return dedup
}
