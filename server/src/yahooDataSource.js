// Yahoo Finance data source — server-side proxy.
// Fornisce candele OHLC per forex / metalli / oil quando TwelveData ha quota esaurita.
//
// Endpoint Yahoo v8:
//   https://query1.finance.yahoo.com/v8/finance/chart/{symbol}?interval=...&range=...
// Niente API key, niente quota giornaliera. Dati delayed di 15-30 min, accettabile
// per analisi MTF/EMA/pattern (non per execution).
//
// Mappatura simboli interni → Yahoo ticker:
//   EURUSD → EURUSD=X        (forex spot Yahoo)
//   GBPUSD → GBPUSD=X
//   USDJPY → USDJPY=X
//   GBPJPY → GBPJPY=X
//   EURGBP → EURGBP=X
//   EURJPY → EURJPY=X
//   XAUUSD → GC=F             (Gold continuous futures - proxy spot)
//   USOIL  → CL=F             (WTI Crude continuous futures)
//   DXY    → DX-Y.NYB         (US Dollar Index)
//
// Timeframe interni → Yahoo interval (Yahoo: 1m/2m/5m/15m/30m/60m/90m/1h/1d/5d/1wk/1mo)
//   1m → 1m, 5m → 5m, 15m → 15m, 1h → 60m, 1D → 1d
//   4h non supportato nativo: usiamo 60m + aggregazione 4-bar lato server.

const SYMBOL_MAP = {
  EURUSD: 'EURUSD=X',
  GBPUSD: 'GBPUSD=X',
  USDJPY: 'USDJPY=X',
  GBPJPY: 'GBPJPY=X',
  EURGBP: 'EURGBP=X',
  EURJPY: 'EURJPY=X',
  XAUUSD: 'GC=F',
  USOIL:  'CL=F',
  DXY:    'DX-Y.NYB',
}

const INTERVAL_MAP = {
  '1m':  '1m',
  '5m':  '5m',
  '15m': '15m',
  '30m': '30m',
  '1h':  '60m',
  '4h':  '60m',   // fetched at 60m, then aggregated 4:1 below
  '1D':  '1d',
}

// Range Yahoo per ottenere ~500 bar al timeframe richiesto.
// Yahoo limits: 1m max 7d, 5m max 60d, 15m/30m/60m max 730d, 1d max 50y.
const RANGE_FOR_INTERVAL = {
  '1m':  '5d',     // 5d × 1440 = 7200 bar 1m (filtra a 500)
  '5m':  '15d',    // 15d × 288 = 4320 bar 5m
  '15m': '60d',    // 60d × 96 = 5760 bar 15m
  '30m': '60d',
  '60m': '730d',   // 2y × 24 = 17520 bar 60m (filtra a 500)
  '1d':  '5y',
}

const YAHOO_HOSTS = [
  'https://query1.finance.yahoo.com',
  'https://query2.finance.yahoo.com',
]

// Browser-like User-Agent: alcuni edge node Yahoo bloccano richieste senza UA
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'

/**
 * Fetch raw chart data from Yahoo Finance v8.
 * Tenta query1, fallback su query2 se primo timeout/errore.
 */
async function fetchYahooChart(yahooSymbol, interval, range) {
  let lastErr
  for (const host of YAHOO_HOSTS) {
    const url = `${host}/v8/finance/chart/${encodeURIComponent(yahooSymbol)}?interval=${interval}&range=${range}&includePrePost=false&events=div%2Csplit`
    try {
      const ctrl = new AbortController()
      const timer = setTimeout(() => ctrl.abort(), 8000)
      const res = await fetch(url, {
        headers: { 'User-Agent': UA, 'Accept': 'application/json' },
        signal: ctrl.signal,
      })
      clearTimeout(timer)
      if (!res.ok) { lastErr = new Error(`HTTP ${res.status}`); continue }
      const json = await res.json()
      if (json?.chart?.error) {
        lastErr = new Error(json.chart.error.description || 'yahoo error')
        continue
      }
      return json
    } catch (e) {
      lastErr = e
    }
  }
  throw lastErr || new Error('yahoo unreachable')
}

/**
 * Parse Yahoo chart response → array di candele OHLCV.
 * Filtra le bar incomplete (nulls per pre-market o gap di mercato).
 */
function parseCandles(json) {
  const result = json?.chart?.result?.[0]
  if (!result) return []
  const ts = result.timestamp || []
  const q = result.indicators?.quote?.[0] || {}
  const opens = q.open || []
  const highs = q.high || []
  const lows  = q.low  || []
  const closes = q.close || []
  const volumes = q.volume || []
  const out = []
  for (let i = 0; i < ts.length; i++) {
    const o = opens[i], h = highs[i], l = lows[i], c = closes[i]
    if (o == null || h == null || l == null || c == null) continue
    out.push({
      time: ts[i],
      open: o,
      high: h,
      low:  l,
      close: c,
      volume: volumes[i] || 0,
    })
  }
  return out
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
 * Public API: fetch candele Yahoo per un simbolo + timeframe interni.
 * @param {string} symbol  es. 'EURUSD', 'XAUUSD'
 * @param {string} tf      es. '15m', '1h', '4h', '1D'
 * @param {number} count   numero massimo di candele da restituire (default 500)
 * @returns {Promise<{symbol, tf, candles, source}>}
 */
export async function yahooFetchCandles(symbol, tf, count = 500) {
  const yahooSymbol = SYMBOL_MAP[symbol]
  if (!yahooSymbol) throw new Error(`yahoo: symbol not mapped ${symbol}`)
  const interval = INTERVAL_MAP[tf]
  if (!interval) throw new Error(`yahoo: timeframe not mapped ${tf}`)
  const range = RANGE_FOR_INTERVAL[interval] || '60d'

  const json = await fetchYahooChart(yahooSymbol, interval, range)
  let candles = parseCandles(json)

  // 4h: aggregare 4 candele da 60m
  if (tf === '4h') candles = aggregate(candles, 4)

  // Limita all'ultimo count bar
  if (candles.length > count) candles = candles.slice(-count)

  return {
    symbol,
    tf,
    candles,
    source: 'yahoo',
    yahoo_symbol: yahooSymbol,
  }
}

/**
 * Lista simboli supportati (per /api/yahoo/symbols health check).
 */
export function yahooListSymbols() {
  return Object.entries(SYMBOL_MAP).map(([k, v]) => ({ symbol: k, yahoo: v }))
}
