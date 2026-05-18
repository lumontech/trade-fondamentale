// Finnhub data source — server-side fetcher per forex / XAU usato dalla simulazione.
// Feed sottostante: OANDA (stesso provider dei widget TradingView mostrati in UI).
// Free tier: 60 req/min, real-time forex spot.
//
// Endpoint: GET https://finnhub.io/api/v1/forex/candle
//   ?symbol=OANDA:EUR_USD&resolution=60&from=<unix>&to=<unix>&token=<KEY>
//
// Response (success):
//   { c:[closes], h:[highs], l:[lows], o:[opens], t:[unix_secs], v:[volumes], s:"ok" }
// Response (no data):
//   { s:"no_data" }
// Response (auth error):
//   { error: "Invalid API key" }   (HTTP 401)

const SYMBOL_MAP = {
  EURUSD: 'OANDA:EUR_USD',
  GBPUSD: 'OANDA:GBP_USD',
  USDJPY: 'OANDA:USD_JPY',
  GBPJPY: 'OANDA:GBP_JPY',
  EURGBP: 'OANDA:EUR_GBP',
  EURJPY: 'OANDA:EUR_JPY',
  XAUUSD: 'OANDA:XAU_USD',
  USOIL:  'OANDA:WTICO_USD',
  // DXY / US500 / NAS100 non sono nel piano free forex Finnhub → fallback altrove
}

const RESOLUTION_MAP = {
  '1m':  '1',
  '5m':  '5',
  '15m': '15',
  '30m': '30',
  '1h':  '60',
  '4h':  '60',    // aggregare 4:1 lato server
  '1D':  'D',
}

// Stima secondi per resolution per calcolare il range "from"
const RES_SECONDS = {
  '1':  60,
  '5':  300,
  '15': 900,
  '30': 1800,
  '60': 3600,
  'D':  86400,
}

const FINNHUB_BASE = 'https://finnhub.io/api/v1'
const UA = 'impact-trading-server/1.0'

export function finnhubSupports(symbol) {
  return symbol in SYMBOL_MAP
}

/**
 * Aggrega N candele consecutive in una sola (per costruire 4h da 1h).
 */
function aggregate(candles, factor) {
  if (factor <= 1) return candles
  const out = []
  for (let i = 0; i + factor <= candles.length; i += factor) {
    const slice = candles.slice(i, i + factor)
    out.push({
      time: slice[0].time,
      open: slice[0].open,
      high: Math.max(...slice.map(c => c.high)),
      low:  Math.min(...slice.map(c => c.low)),
      close: slice[slice.length - 1].close,
      volume: slice.reduce((s, c) => s + (c.volume || 0), 0),
    })
  }
  return out
}

/**
 * Public API: fetch candele Finnhub per simbolo + timeframe interni.
 * @param {string} symbol   es. 'EURUSD', 'XAUUSD'
 * @param {string} tf       '1m'|'5m'|'15m'|'1h'|'4h'|'1D'
 * @param {string} apiKey   Finnhub personal token
 * @param {number} count    numero max candele (default 500)
 * @returns {Promise<Array<{time,open,high,low,close,volume}>>}
 */
export async function finnhubFetchCandles(symbol, tf, apiKey, count = 500) {
  if (!apiKey) throw new Error('finnhub: api key missing')
  const finSymbol = SYMBOL_MAP[symbol]
  if (!finSymbol) throw new Error(`finnhub: symbol not mapped ${symbol}`)
  const resolution = RESOLUTION_MAP[tf]
  if (!resolution) throw new Error(`finnhub: timeframe not mapped ${tf}`)

  const to = Math.floor(Date.now() / 1000)
  const secPerBar = RES_SECONDS[resolution] || 3600
  // Fetcha 1.5× per assicurare di averne abbastanza dopo l'aggregazione 4h
  const span = (tf === '4h' ? count * 4 : count) * secPerBar * 1.5
  const from = to - Math.floor(span)

  const url = `${FINNHUB_BASE}/forex/candle?symbol=${encodeURIComponent(finSymbol)}&resolution=${resolution}&from=${from}&to=${to}&token=${encodeURIComponent(apiKey)}`

  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), 10000)
  let res
  try {
    res = await fetch(url, { headers: { 'User-Agent': UA }, signal: ctrl.signal })
  } finally {
    clearTimeout(timer)
  }
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(`finnhub HTTP ${res.status}: ${body.slice(0, 200)}`)
  }
  const j = await res.json()
  if (j.s !== 'ok') {
    if (j.s === 'no_data') return []
    throw new Error(`finnhub status: ${j.s || JSON.stringify(j).slice(0, 200)}`)
  }
  const len = j.t?.length || 0
  if (!len) return []

  let candles = new Array(len)
  for (let i = 0; i < len; i++) {
    candles[i] = {
      time:   j.t[i],
      open:   j.o[i],
      high:   j.h[i],
      low:    j.l[i],
      close:  j.c[i],
      volume: j.v?.[i] || 0,
    }
  }
  // Garantisce ordinamento crescente (Finnhub di solito lo fa, ma safety net)
  candles.sort((a, b) => a.time - b.time)

  if (tf === '4h') candles = aggregate(candles, 4)
  if (candles.length > count) candles = candles.slice(-count)
  return candles
}

/**
 * Lista simboli supportati (per /api/finnhub/symbols).
 */
export function finnhubListSymbols() {
  return Object.entries(SYMBOL_MAP).map(([k, v]) => ({ symbol: k, finnhub: v }))
}
