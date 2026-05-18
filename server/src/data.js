// Data fetchers: Binance (BTC) + cascata multi-broker per forex/XAU/oil:
//   Finnhub (OANDA feed, real-time, free) → TwelveData → Yahoo Finance (delayed)
// Cache TTL = 60s per default (= polling interval del cron).
import { finnhubFetchCandles, finnhubSupports } from './finnhubDataSource.js'
import { yahooFetchCandles } from './yahooDataSource.js'
import { ctraderFixGetCandles, ctraderFixIsReady } from './ctraderFixClient.js'

const TF_MAP_BINANCE = {
  '1m': '1m', '5m': '5m', '15m': '15m',
  '1h': '1h', '4h': '4h', '1D': '1d',
}
const TF_MAP_TD = {
  '1m': '1min', '5m': '5min', '15m': '15min',
  '1h': '1h',  '4h': '4h',  '1D': '1day',
}

// TF -> seconds per stale-cache check (Fix #2.6) e heartbeat affini.
const TF_TO_SEC = {
  '1m': 60, '5m': 300, '15m': 900,
  '1h': 3600, '4h': 14400, '1D': 86400,
}

// ── TwelveData quota tracking (Fix #2.4) ──────────────────────────
// Conta le chiamate consumate (in credits) e fornisce un endpoint
// /api/health/twelvedata per monitorare lo stato giornaliero.
// 2 keys free × 800 credits/day = 1600 credits totali.
let tdCallsToday = 0
let tdResetDay = new Date().toUTCString().slice(0, 16)  // "Sat, 10 May 2026"
const TD_QUOTA_LIMIT = 1600

// Credits per chiamata TwelveData secondo la doc:
//   1m / 5m / 15m / 1h: 1 credit
//   4h: time_series con interval=4h costa 1 credit (è un endpoint nativo)
//   1D: 1 credit
// Per ora assumiamo 1 credit/chiamata (le free key sono limitate cosi).
function creditsForTimeframe(_tf) { return 1 }

export function recordTdCall(n = 1) {
  const today = new Date().toUTCString().slice(0, 16)
  if (today !== tdResetDay) {
    tdResetDay = today
    tdCallsToday = 0
  }
  tdCallsToday += n
}

export function getTdQuota() {
  // Auto-reset se cambiato giorno UTC
  const today = new Date().toUTCString().slice(0, 16)
  if (today !== tdResetDay) {
    tdResetDay = today
    tdCallsToday = 0
  }
  return {
    used: tdCallsToday,
    limit: TD_QUOTA_LIMIT,
    remaining: Math.max(0, TD_QUOTA_LIMIT - tdCallsToday),
    resetDay: tdResetDay,
  }
}

const ROUTING = {
  // FP Markets / Forex via TwelveData
  BTCUSD: 'binance',  ETHUSD: 'binance',
  XAUUSD: 'td', EURUSD: 'td', GBPUSD: 'td',
  USDJPY: 'td', GBPJPY: 'td', EURGBP: 'td', EURJPY: 'td',
  US500:  'td', NAS100: 'td', USOIL:  'td', DXY:    'td',
  // Hyperliquid USDC perpetual via Binance USDC perp (stesso mercato pricing)
  // HYPE solo su Hyperliquid native API
  BTCUSDC: 'binance', ETHUSDC: 'binance',
  SOLUSDC: 'binance', XRPUSDC: 'binance',
  BNBUSDC: 'binance',
  HYPEUSDC: 'hyperliquid',
  'USDT-USDC': 'hyperliquid',
}

const TD_SYMBOLS = {
  XAUUSD: 'XAU/USD', EURUSD: 'EUR/USD', GBPUSD: 'GBP/USD',
  USDJPY: 'USD/JPY', GBPJPY: 'GBP/JPY', EURGBP: 'EUR/GBP', EURJPY: 'EUR/JPY',
}

const SYMBOL_MAP_BINANCE = {
  BTCUSD: 'BTCUSDT', ETHUSD: 'ETHUSDT',
  // Hyperliquid USDC pair → Binance USDC pair (orderbook similare per pricing)
  BTCUSDC: 'BTCUSDC', ETHUSDC: 'ETHUSDC',
  SOLUSDC: 'SOLUSDC', XRPUSDC: 'XRPUSDC', BNBUSDC: 'BNBUSDC',
}

// Hyperliquid native API per HYPE token + cross-check pricing
const HYPERLIQUID_SYMBOL_MAP = {
  HYPEUSDC: 'HYPE', 'USDT-USDC': 'USDT',
  BTCUSDC: 'BTC', ETHUSDC: 'ETH', SOLUSDC: 'SOL', XRPUSDC: 'XRP', BNBUSDC: 'BNB',
}
const TF_MAP_HYPERLIQUID = {
  '1m': '1m', '5m': '5m', '15m': '15m',
  '1h': '1h', '4h': '4h', '1D': '1d',
}

// Cache TTL adaptive per TF — minimizza consumo TwelveData (800 credits/giorno per key).
// Strategia: cache lunga = bar arriva 1-2 min in ritardo ma quota free dura tutto il giorno.
// Calcolo target: 7 pair TD × 24h / cache_TTL = chiamate/giorno (per pair).
// Budget: 1600 credits/giorno (2 keys), con margine 1000 utili → ≤140/pair/giorno = 1 ogni 10min.
const CACHE_TTL_BY_TF = {
  '1m':  120,    // 2 min   (alta freq scalp)
  '5m':  300,    // 5 min
  '15m': 600,    // 10 min  (target scalp 15m: bar fresco entro 2/3 del bar)
  '1h':  1800,   // 30 min
  '4h':  3600,   // 1 h     (4h bar: refresh 1/4 del bar è OK)
  '1D':  21600,  // 6 ore
}
const DEFAULT_CACHE_TTL = 600   // 10 min

// Outputsize per TF: timeframes lunghi (4h, 1D) hanno bisogno di più barre
// per warm-up degli indicatori (EMA50 / lookback strategy).
const OUTPUTSIZE_BY_TF = {
  '1m': 200, '5m': 200, '15m': 200, '1h': 200,
  '4h': 400,
  '1D': 400,
}
function getOutputsize(tf) { return OUTPUTSIZE_BY_TF[tf] || 200 }

// ── Fetch Binance candles ─────────────────────────────────────────
async function fetchBinanceCandles(symbol, interval, limit) {
  const pair = SYMBOL_MAP_BINANCE[symbol] || symbol
  const tf = TF_MAP_BINANCE[interval] || '1h'
  const lim = limit || getOutputsize(interval)
  const url = `https://api.binance.com/api/v3/klines?symbol=${pair}&interval=${tf}&limit=${lim}`
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

// ── Fetch Hyperliquid candles (info endpoint, no auth) ────────────
async function fetchHyperliquidCandles(symbol, interval, limit) {
  const coin = HYPERLIQUID_SYMBOL_MAP[symbol]
  if (!coin) throw new Error(`Hyperliquid symbol mapping missing: ${symbol}`)
  const tf = TF_MAP_HYPERLIQUID[interval] || '1h'
  const lim = limit || getOutputsize(interval)
  const tfSec = TF_TO_SEC[interval] || 3600
  const endTime = Date.now()
  const startTime = endTime - lim * tfSec * 1000
  const body = {
    type: 'candleSnapshot',
    req: { coin, interval: tf, startTime, endTime },
  }
  const res = await fetch('https://api.hyperliquid.xyz/info', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!res.ok) throw new Error(`Hyperliquid ${res.status}`)
  const data = await res.json()
  if (!Array.isArray(data)) throw new Error('Hyperliquid: unexpected response')
  return data.map(k => ({
    time: Math.floor(k.t / 1000),
    open: parseFloat(k.o),
    high: parseFloat(k.h),
    low:  parseFloat(k.l),
    close: parseFloat(k.c),
    volume: parseFloat(k.v || 0),
  }))
}

// ── Fetch TwelveData candles con rotazione key ────────────────────
async function fetchTDCandles(symbol, interval, apiKeys, outputsize) {
  const tdSym = TD_SYMBOLS[symbol]
  if (!tdSym) throw new Error(`TD symbol mapping missing: ${symbol}`)
  const tf = TF_MAP_TD[interval] || '1h'
  const size = outputsize || getOutputsize(interval)

  // Prova ogni key in ordine; passa alla prossima se 429 o limite
  let lastError
  for (const key of apiKeys) {
    if (!key) continue
    try {
      // Fix #3.4: API key via Authorization header (no leak in URL/log/cache).
      // TwelveData supporta `Authorization: apikey YOUR_KEY` (vedi loro docs).
      // Fallback automatico a query-string se header rifiutato (401), per
      // resilienza in caso TD cambi policy.
      const baseUrl = `https://api.twelvedata.com/time_series?symbol=${tdSym}&interval=${tf}&outputsize=${size}&timezone=UTC`
      let res = await fetch(baseUrl, {
        headers: { 'Authorization': `apikey ${key}` },
      })
      if (res.status === 401) {
        // Fallback a query-string (compat se header non supportato)
        res = await fetch(`${baseUrl}&apikey=${key}`)
      }
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
      // Fix #2.4: record TD call only on successful fetch (not on errors/limit-exhausted)
      recordTdCall(creditsForTimeframe(interval))
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
async function getCachedCandles(db, symbol, timeframe, ttlSec) {
  const ttl = ttlSec || CACHE_TTL_BY_TF[timeframe] || DEFAULT_CACHE_TTL
  const row = await db.prepare(
    'SELECT fetched_at, candles_json FROM candle_cache WHERE symbol = ? AND timeframe = ?'
  ).bind(symbol, timeframe).first()
  if (!row) return null
  const age = Math.floor(Date.now() / 1000) - row.fetched_at
  if (age > ttl) return null
  let parsed
  try {
    parsed = JSON.parse(row.candles_json)
  } catch {
    return null
  }
  // Fix #2.6: stale-cache invalidator — anche se siamo entro il TTL,
  // se la prossima bar attesa e' gia' arrivata (e.g. tf=15m e l'ultima bar
  // ha time T0 ma now > T0 + 15m) -> forza refetch.
  const lastCandle = parsed?.[parsed.length - 1]
  if (lastCandle?.time) {
    const tfSec = TF_TO_SEC[timeframe] || 60
    const expectedNextBar = lastCandle.time + tfSec
    if (Math.floor(Date.now() / 1000) >= expectedNextBar) {
      return null  // stale: la prossima bar e' dovuta
    }
  }
  return parsed
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
    // Cascata multi-broker per forex/XAU/oil — ordine per qualita' e affidabilita':
    //   a) cTrader FIX (FPMarkets) — feed broker live tick-by-tick, identico a TradingView
    //   b) Finnhub (feed OANDA, free tier ha solo stocks ma comunque tentato)
    //   c) TwelveData (storica primaria, quota giornaliera 1600 credits)
    //   d) Yahoo Finance (fallback senza key, delayed 15-30min)
    let lastErr

    // a) cTrader FIX in-memory candles (se connesso e ha abbastanza barre)
    if (ctraderFixIsReady()) {
      const fixCandles = ctraderFixGetCandles(symbol, timeframe, 500)
      // FIX aggrega tick live: serve abbastanza tempo per accumulare candele storiche.
      // Se ne abbiamo >= 50 (qualita' utile per analisi), preferiamo questa fonte.
      if (fixCandles && fixCandles.length >= 50) {
        candles = fixCandles
      }
    }

    // b) Finnhub
    if (!candles?.length) {
      const finnhubKey = process.env.FINNHUB_API_KEY
      if (finnhubKey && finnhubSupports(symbol)) {
        try {
          candles = await finnhubFetchCandles(symbol, timeframe, finnhubKey, 500)
          if (!candles?.length) candles = null
        } catch (e) {
          lastErr = e
          console.warn(`[data] Finnhub ${symbol}/${timeframe} failed:`, e.message)
        }
      }
    }

    // c) TwelveData
    if (!candles?.length && tdApiKeys.some(k => k)) {
      try { candles = await fetchTDCandles(symbol, timeframe, tdApiKeys) }
      catch (e) {
        lastErr = e
        console.warn(`[data] TwelveData ${symbol}/${timeframe} failed:`, e.message)
      }
    }

    // d) Yahoo Finance
    if (!candles?.length) {
      try { candles = (await yahooFetchCandles(symbol, timeframe, 500)).candles }
      catch (e) {
        lastErr = e
        console.warn(`[data] Yahoo ${symbol}/${timeframe} failed:`, e.message)
      }
    }

    if (!candles?.length) {
      throw new Error(`No data for ${symbol}/${timeframe} from any broker (last: ${lastErr?.message || 'n/a'})`)
    }
  } else if (source === 'hyperliquid') {
    candles = await fetchHyperliquidCandles(symbol, timeframe)
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
