// Smart Money Concepts (SMC) — order blocks, fair value gaps, BOS/CHoCH, liquidity zones.
// Calcolato dalle candele OHLC. Usato dal forex/oro pro retail.

/**
 * Identifica swing highs e swing lows.
 * Uno swing high è una candela con high > high di N candele a sinistra E destra.
 */
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
 * Fair Value Gap (FVG): area di prezzo non testata tra 3 candele consecutive.
 * Bullish FVG: low della candela 3 > high della candela 1.
 * Bearish FVG: high della candela 3 < low della candela 1.
 */
function findFVGs(candles, maxLookback = 80) {
  const fvgs = []
  const start = Math.max(2, candles.length - maxLookback)
  for (let i = start; i < candles.length; i++) {
    const c1 = candles[i - 2], c2 = candles[i - 1], c3 = candles[i]
    if (c3.low > c1.high) {
      // Bullish FVG tra c1.high e c3.low
      fvgs.push({ type: 'bullish', top: c3.low, bottom: c1.high, index: i, time: c2.time })
    } else if (c3.high < c1.low) {
      // Bearish FVG tra c3.high e c1.low
      fvgs.push({ type: 'bearish', top: c1.low, bottom: c3.high, index: i, time: c2.time })
    }
  }
  return fvgs
}

/**
 * Order Block (OB): ultima candela contraria prima di un movimento direzionale forte.
 * Bullish OB: ultima candela bearish prima di un breakout rialzista.
 * Bearish OB: ultima candela bullish prima di un breakdown.
 */
function findOrderBlocks(candles, breakoutAtrMultiplier = 1.5, maxLookback = 100) {
  const obs = []
  const start = Math.max(5, candles.length - maxLookback)
  // Calcola ATR semplificato per soglia breakout
  let atr = 0
  for (let i = candles.length - 14; i < candles.length; i++) {
    if (i > 0) atr += Math.abs(candles[i].high - candles[i].low)
  }
  atr /= 14
  const minMove = atr * breakoutAtrMultiplier

  for (let i = start + 1; i < candles.length - 1; i++) {
    const c   = candles[i]
    const next = candles[i + 1]
    // Bullish OB: c bearish, next bullish con range > minMove e chiude sopra c.high
    const isCBearish = c.close < c.open
    const isCBullish = c.close > c.open
    if (isCBearish && next.close > c.high && (next.close - next.open) > minMove) {
      obs.push({ type: 'bullish', top: c.high, bottom: c.low, index: i, time: c.time })
    } else if (isCBullish && next.close < c.low && (next.open - next.close) > minMove) {
      obs.push({ type: 'bearish', top: c.high, bottom: c.low, index: i, time: c.time })
    }
  }
  return obs
}

/**
 * Liquidity zones: highs/lows recenti dove tipicamente ci sono stop dei retail.
 * Restituisce i 3 highs più recenti e 3 lows più recenti significativi.
 */
function findLiquidity(candles, lookback = 50) {
  const swings = findSwings(candles.slice(-lookback))
  return {
    upper_liquidity: swings.highs.slice(-3).map(s => s.price),
    lower_liquidity: swings.lows.slice(-3).map(s => s.price),
  }
}

/**
 * Break of Structure (BOS): prezzo rompe un swing high (bullish) o swing low (bearish).
 * Change of Character (CHoCH): primo BOS contro il trend precedente, segnala possibile reversal.
 */
function findStructure(candles) {
  const swings = findSwings(candles, 3)
  if (swings.highs.length < 2 || swings.lows.length < 2) return null

  const lastClose = candles[candles.length - 1].close
  const lastSwingHigh = swings.highs[swings.highs.length - 1]
  const lastSwingLow  = swings.lows[swings.lows.length - 1]
  const prevSwingHigh = swings.highs[swings.highs.length - 2]
  const prevSwingLow  = swings.lows[swings.lows.length - 2]

  // Trend basato su Higher Highs / Higher Lows o Lower Highs / Lower Lows
  const isHH = lastSwingHigh.price > prevSwingHigh.price
  const isHL = lastSwingLow.price  > prevSwingLow.price
  const isLH = lastSwingHigh.price < prevSwingHigh.price
  const isLL = lastSwingLow.price  < prevSwingLow.price

  let trend = 'range'
  if (isHH && isHL) trend = 'uptrend'
  else if (isLH && isLL) trend = 'downtrend'

  // BOS recente?
  let bos = null
  if (lastClose > lastSwingHigh.price && lastSwingHigh.index > candles.length - 20) {
    bos = { type: 'bullish_bos', level: lastSwingHigh.price }
  } else if (lastClose < lastSwingLow.price && lastSwingLow.index > candles.length - 20) {
    bos = { type: 'bearish_bos', level: lastSwingLow.price }
  }

  // CHoCH: BOS contro il trend precedente
  let choch = null
  if (bos) {
    if (bos.type === 'bullish_bos' && trend === 'downtrend') choch = bos
    if (bos.type === 'bearish_bos' && trend === 'uptrend')   choch = bos
  }

  return { trend, bos, choch, last_swing_high: lastSwingHigh.price, last_swing_low: lastSwingLow.price }
}

/**
 * Wrapper completo: calcola tutta l'analisi SMC.
 */
export function analyzeSMC(candles) {
  if (!candles || candles.length < 30) return null

  const fvgs = findFVGs(candles, 80).slice(-5)        // ultimi 5 FVG
  const obs  = findOrderBlocks(candles).slice(-5)     // ultimi 5 OB
  const liquidity = findLiquidity(candles, 50)
  const structure = findStructure(candles)

  // Bias direzionale derivato
  let smcBias = 'neutral'
  if (structure?.choch?.type === 'bullish_bos') smcBias = 'bullish_reversal'
  else if (structure?.choch?.type === 'bearish_bos') smcBias = 'bearish_reversal'
  else if (structure?.trend === 'uptrend')  smcBias = 'bullish_continuation'
  else if (structure?.trend === 'downtrend') smcBias = 'bearish_continuation'

  return {
    bias: smcBias,
    structure,
    fvgs,
    order_blocks: obs,
    liquidity,
  }
}

// Sintesi compatta per ContextPack
export function summarizeSMC(smc) {
  if (!smc) return null
  return {
    bias:           smc.bias,
    trend:          smc.structure?.trend,
    bos:            smc.structure?.bos?.type || null,
    choch:          smc.structure?.choch?.type || null,
    fvg_count:      smc.fvgs.length,
    last_fvg:       smc.fvgs[smc.fvgs.length - 1] || null,
    order_blocks:   smc.order_blocks.slice(-2).map(ob => ({ type: ob.type, top: ob.top, bottom: ob.bottom })),
    upper_liquidity: smc.liquidity.upper_liquidity,
    lower_liquidity: smc.liquidity.lower_liquidity,
  }
}
