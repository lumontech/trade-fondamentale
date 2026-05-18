// YahooService — fetcha candele da Yahoo Finance via proxy server-side.
// Usato come fallback automatico per forex/XAU/oil quando TwelveData ha quota esaurita.
//
// Il browser non può chiamare Yahoo direttamente (CORS), quindi tutto passa per
// l'endpoint backend GET /api/yahoo/candles?symbol=XAUUSD&tf=1h&count=500
//
// In dev: proxy via vite verso http://localhost:3000
// In prod: stessa origin → /api/yahoo/...

const API_BASE = ''  // same-origin

const SUPPORTED = new Set([
  'EURUSD', 'GBPUSD', 'USDJPY', 'GBPJPY', 'EURGBP', 'EURJPY',
  'XAUUSD', 'USOIL', 'DXY',
])

export function yahooSupports(symbol) {
  return SUPPORTED.has(symbol)
}

/**
 * Fetcha candele dal proxy backend Yahoo.
 * @param {string} symbol   es. 'XAUUSD', 'EURUSD'
 * @param {string} tf       '1m'|'5m'|'15m'|'1h'|'4h'|'1D'
 * @param {number} count    max candele da restituire (default 500)
 * @returns {Promise<Array<{time,open,high,low,close,volume}>>}
 */
export async function fetchYahooCandles(symbol, tf, count = 500) {
  if (!yahooSupports(symbol)) throw new Error(`yahoo: symbol not supported ${symbol}`)
  const url = `${API_BASE}/api/yahoo/candles?symbol=${encodeURIComponent(symbol)}&tf=${encodeURIComponent(tf)}&count=${count}`
  const res = await fetch(url, { credentials: 'include' })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`yahoo proxy HTTP ${res.status}: ${text.slice(0, 200)}`)
  }
  const json = await res.json()
  if (json.error) throw new Error(json.error)
  return json.candles || []
}
