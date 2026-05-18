// Currency Strength Meter — calcola la forza relativa di ogni valuta
// guardando il movimento di tutte le coppie disponibili.
// Utile per capire chi guida il movimento (USD forte vs EUR debole?).

const CURRENCIES = ['USD', 'EUR', 'GBP', 'JPY', 'XAU', 'OIL', 'BTC']

// Mappa simbolo → { base, quote }
const PAIR_MAP = {
  EURUSD: { base: 'EUR', quote: 'USD' },
  GBPUSD: { base: 'GBP', quote: 'USD' },
  USDJPY: { base: 'USD', quote: 'JPY' },
  GBPJPY: { base: 'GBP', quote: 'JPY' },
  XAUUSD: { base: 'XAU', quote: 'USD' },
  USOIL:  { base: 'OIL', quote: 'USD' },
  BTCUSD: { base: 'BTC', quote: 'USD' },
}

// Performance percentuale di un instrument su lookback N candele
function pctMove(candles, lookback) {
  if (!candles || candles.length < lookback + 1) return null
  const start = candles[candles.length - 1 - lookback]?.close
  const end = candles[candles.length - 1]?.close
  if (!start || !end) return null
  return ((end - start) / start) * 100
}

/**
 * Calcola la "forza" di ogni valuta basata sul movimento delle coppie disponibili.
 * Per ogni valuta, somma il movimento delle coppie dove è BASE (positivo se sale)
 * e sottrae il movimento dove è QUOTE (negativo se la coppia sale).
 *
 * @param {Object} instruments — store.instruments
 * @param {Number} lookback — quante candele confrontare (default 24)
 * @returns {Object} { currencies: { CURR: { strength, count, change_pct } }, performance: [{symbol, pct}] }
 */
export function calculateCurrencyStrength(instruments, lookback = 24) {
  const strengths = {}    // CURR → array di percent moves
  const performance = []

  for (const [symbol, pair] of Object.entries(PAIR_MAP)) {
    const inst = instruments[symbol]
    if (!inst?.candles?.length) continue
    const pct = pctMove(inst.candles, lookback)
    if (pct == null) continue
    performance.push({ symbol, pct })

    // Base + quote
    if (!strengths[pair.base]) strengths[pair.base] = []
    if (!strengths[pair.quote]) strengths[pair.quote] = []
    strengths[pair.base].push(pct)
    strengths[pair.quote].push(-pct)
  }

  // Aggrega: media dei movimenti
  const currencies = {}
  for (const c of CURRENCIES) {
    if (!strengths[c] || strengths[c].length === 0) continue
    const avg = strengths[c].reduce((s, x) => s + x, 0) / strengths[c].length
    currencies[c] = {
      strength:    Math.round(avg * 100) / 100,
      count:       strengths[c].length,
      change_pct:  Math.round(avg * 100) / 100,
    }
  }

  // Ordina per forza
  const sorted = Object.entries(currencies)
    .map(([curr, data]) => ({ currency: curr, ...data }))
    .sort((a, b) => b.strength - a.strength)

  return {
    currencies,
    sorted,
    performance: performance.sort((a, b) => b.pct - a.pct),
    strongest: sorted[0]?.currency,
    weakest:   sorted[sorted.length - 1]?.currency,
  }
}

/**
 * Performance multi-timeframe per un singolo simbolo.
 * Restituisce % movimento su 1h, 4h, 1D, 1W (se candele disponibili).
 */
export function multiPerformance(instrument) {
  if (!instrument) return null
  const candles = instrument.candles
  if (!candles?.length) return null

  // Stima approssimativa: lookback in candele del TF attivo
  // 24 candele 1h ≈ 1D, 6 candele 4h ≈ 1D, 1 candela 1D ≈ 1D
  // Generic: prendiamo % su 1, 6, 24, 168 candele se disponibili
  return {
    last:      pctMove(candles, 1),
    last_6:    pctMove(candles, 6),
    last_24:   pctMove(candles, 24),
    last_168:  pctMove(candles, 168),
  }
}
