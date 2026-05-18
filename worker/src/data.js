// Data fetchers: Binance (BTC) + TwelveData (forex/XAU) con cache D1.
// Cache TTL = 60s per default (= polling interval del cron).

const TF_MAP_BINANCE = {
  '1m': '1m', '5m': '5m', '15m': '15m',
  '1h': '1h', '4h': '4h', '1D': '1d',
}
const TF_MAP_TD = {
  '1m': '1min', '5m': '5min', '15m': '15min',
  '1h': '1h',  '4h': '4h',  '1D': '1day',
}

const ROUTING = {
  BTCUSD: 'binance',  ETHUSD: 'binance',
  XAUUSD: 'td', EURUSD: 'td', GBPUSD: 'td',
  USDJPY: 'td', GBPJPY: 'td', EURGBP: 'td', EURJPY: 'td',
  US500:  'td', NAS100: 'td', USOIL:  'td', DXY:    'td',
}

const TD_SYMBOLS = {
  XAUUSD: 'XAU/USD', EURUSD: 'EUR/USD', GBPUSD: 'GBP/USD',
  USDJPY: 'USD/JPY', GBPJPY: 'GBP/JPY', EURGBP: 'EUR/GBP', EURJPY: 'EUR/JPY',
}

const SYMBOL_MAP_BINANCE = { BTCUSD: 'BTCUSDT', ETHUSD: 'ETHUSDT' }

const CACHE_TTL_SECONDS = 50   // 50s — leggermente meno del polling interval per evitare miss

// ── Fetch Binance candles ─────────────────────────────────────────
async function fetchBinanceCandles(symbol, interval, limit = 200) {
  const pair = SYMBOL_MAP_BINANCE[symbol] || symbol
  const tf = TF_MAP_BINANCE[interval] || '1h'
  const url = `https://api.binance.com/api/v3/klines?symbol=${pair}&interval=${tf}&limit=${limit}`
  const res = await fetch(url)
  if (!res.ok) throw new Error(`Binance ${res.status}`)
  const data = await res.json()
  return data.map(k => ({
    time: Math.floor(k[0] / 1000),
    open: parseFloat(k[1]),
    high: parseFloat(k[2]),
    low:  parseFloat(k[3]),
    close: parseFloat(k[4]),
    volume: parseFloat(k[5]),
  }))
}

// ── Fetch TwelveData candles con rotazione key ────────────────────
async function fetchTDCandles(symbol, interval, apiKeys, outputsize = 200) {
  const tdSym = TD_SYMBOLS[symbol]
  if (!tdSym) throw new Error(`TD symbol mapping missing: ${symbol}`)
  const tf = TF_MAP_TD[interval] || '1h'

  // Prova ogni key in ordine; passa alla prossima se 429 o limite
  let lastError
  for (const key of apiKeys) {
    if (!key) continue
    try {
      const url = `https://api.twelvedata.com/time_series?symbol=${tdSym}&interval=${tf}&outputsize=${outputsize}&timezone=UTC&apikey=${key}`
      const res = await fetch(url)
      const data = await res.json()
      if (data.status === 'error') {
        lastError = new Error(data.message)
        // Se è rate limit / daily exhaustion → prova prossima key
        const msg = (data.message || '').toLowerCase()
        if (msg.includes('limit') || msg.includes('credit')) continue
        throw lastError
      }
      if (!data.values) {
        lastError = new Error('No candle data')
        continue
      }
      return data.values.reverse().map(v => {
        const isoUtc = v.datetime.includes('T') ? v.datetime : v.datetime.replace(' ', 'T')
        const utcDt = isoUtc.endsWith('Z') ? isoUtc : isoUtc + 'Z'
        return {
          time: Math.floor(new Date(utcDt).getTime() / 1000),
          open: parseFloat(v.open),
          high: parseFloat(v.high),
          low:  parseFloat(v.low),
          close: parseFloat(v.close),
          volume: parseFloat(v.volume || 0),
        }
      })
    } catch (err) {
      lastError = err
    }
  }
  throw lastError || new Error('Tutte le TD keys hanno fallito')
}

// ── Cache layer su D1 ──────────────────────────────────────────────
async function getCachedCandles(db, symbol, timeframe, ttlSec = CACHE_TTL_SECONDS) {
  const row = await db.prepare(
    'SELECT fetched_at, candles_json FROM candle_cache WHERE symbol = ? AND timeframe = ?'
  ).bind(symbol, timeframe).first()
  if (!row) return null
  const age = Math.floor(Date.now() / 1000) - row.fetched_at
  if (age > ttlSec) return null
  try {
    return JSON.parse(row.candles_json)
  } catch {
    return null
  }
}

async function saveCachedCandles(db, symbol, timeframe, candles) {
  await db.prepare(
    `INSERT INTO candle_cache (symbol, timeframe, fetched_at, candles_json)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(symbol, timeframe) DO UPDATE SET
       fetched_at = excluded.fetched_at,
       candles_json = excluded.candles_json`
  ).bind(symbol, timeframe, Math.floor(Date.now() / 1000), JSON.stringify(candles)).run()
}

// ── Public: load candles con cache ─────────────────────────────────
/**
 * @param {D1Database} db
 * @param {string} symbol
 * @param {string} timeframe
 * @param {string[]} tdApiKeys - array di TwelveData API keys
 * @returns {Promise<Array>} candles
 */
export async function loadCandles(db, symbol, timeframe, tdApiKeys = []) {
  // 1. Try cache
  const cached = await getCachedCandles(db, symbol, timeframe)
  if (cached) return cached

  // 2. Fetch live
  const source = ROUTING[symbol]
  let candles
  if (source === 'binance') {
    candles = await fetchBinanceCandles(symbol, timeframe)
  } else if (source === 'td') {
    if (!tdApiKeys.some(k => k)) {
      throw new Error('TwelveData API key mancante (set via wrangler secret)')
    }
    candles = await fetchTDCandles(symbol, timeframe, tdApiKeys)
  } else {
    throw new Error(`Routing missing for ${symbol}`)
  }

  // 3. Save cache
  if (candles && candles.length > 0) {
    await saveCachedCandles(db, symbol, timeframe, candles)
  }
  return candles
}

export { ROUTING }
