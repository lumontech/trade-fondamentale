// HistoricalLoader — carica candele storiche estese (multi-anno) con paginazione.
// Cache su localStorage per evitare di consumare crediti API ad ogni apertura panel.
import { fetchTDCandles } from './TwelveDataService'

// ── Cache ──────────────────────────────────────────────────────────
const CACHE_PREFIX = 'itp_hist_'
const CACHE_TTL_MS = 12 * 60 * 60 * 1000  // 12h

function cacheKey(symbol, interval, years) {
  return `${CACHE_PREFIX}${symbol}_${interval}_${years}y`
}

function loadFromCache(symbol, interval, years) {
  try {
    const raw = localStorage.getItem(cacheKey(symbol, interval, years))
    if (!raw) return null
    const obj = JSON.parse(raw)
    if (Date.now() - obj.savedAt > CACHE_TTL_MS) return null
    return obj.candles
  } catch { return null }
}

function saveToCache(symbol, interval, years, candles) {
  try {
    localStorage.setItem(cacheKey(symbol, interval, years), JSON.stringify({
      savedAt: Date.now(),
      candles,
    }))
  } catch {
    // localStorage full → ignora
  }
}

export function clearHistoricalCache() {
  try {
    Object.keys(localStorage)
      .filter(k => k.startsWith(CACHE_PREFIX))
      .forEach(k => localStorage.removeItem(k))
  } catch {}
}

// ── Binance: pagina indietro di 1000 candele alla volta ────────────
async function fetchBinanceHistorical(symbol, interval, years) {
  const SYMBOL_MAP = { BTCUSD: 'BTCUSDT', ETHUSD: 'ETHUSDT' }
  const TF_MAP = {
    '1m': { tf: '1m',  ms: 60_000 },
    '5m': { tf: '5m',  ms: 5  * 60_000 },
    '15m':{ tf: '15m', ms: 15 * 60_000 },
    '1h': { tf: '1h',  ms: 60 * 60_000 },
    '4h': { tf: '4h',  ms: 4  * 60 * 60_000 },
    '1D': { tf: '1d',  ms: 24 * 60 * 60_000 },
  }
  const cfg = TF_MAP[interval]
  if (!cfg) throw new Error(`Unsupported interval ${interval}`)
  const pair = SYMBOL_MAP[symbol] || symbol

  const startTime = Date.now() - years * 365 * 24 * 60 * 60_000
  const allCandles = []
  let cursor = startTime
  const LIMIT = 1000

  while (cursor < Date.now()) {
    const url = `https://api.binance.com/api/v3/klines?symbol=${pair}&interval=${cfg.tf}&startTime=${cursor}&limit=${LIMIT}`
    const res = await fetch(url)
    if (!res.ok) throw new Error(`Binance error ${res.status}`)
    const batch = await res.json()
    if (!Array.isArray(batch) || batch.length === 0) break
    for (const k of batch) {
      allCandles.push({
        time:   Math.floor(k[0] / 1000),
        open:   parseFloat(k[1]),
        high:   parseFloat(k[2]),
        low:    parseFloat(k[3]),
        close:  parseFloat(k[4]),
        volume: parseFloat(k[5]),
      })
    }
    // Avanza cursore al timestamp dopo l'ultima candela
    const lastTs = batch[batch.length - 1][0]
    cursor = lastTs + cfg.ms
    if (batch.length < LIMIT) break
    // Soft delay per rispettare il rate limit (1200 weight/min, klines = 1)
    await new Promise(r => setTimeout(r, 80))
  }
  return allCandles
}

// ── TwelveData: 5000 max per richiesta su free tier, paginiamo via end_date ────
async function fetchTDHistorical(symbol, interval, years, apiKey) {
  // Per semplicità su free tier: chiediamo outputsize alta in 1 sola richiesta.
  // Free plan TD: outputsize max 5000, basta per 1D 5y (~1825 bar) e 4h 2y (~4380).
  // Per 5y a 4h serve paginazione che TD non supporta nativamente bene → lasciamo 1D di default.
  const TF_BARS_PER_YEAR = {
    '1m': 525600,  // troppo per multi-year
    '5m': 105120,
    '15m': 35040,
    '1h': 8760,
    '4h': 2190,
    '1D': 365,
  }
  const totalBars = Math.min((TF_BARS_PER_YEAR[interval] || 365) * years, 5000)
  return await fetchTDCandles(symbol, interval, apiKey, totalBars)
}

// ── Public API ─────────────────────────────────────────────────────

const ROUTING = {
  BTCUSD:  'binance',
  ETHUSD:  'binance',
  XAUUSD:  'twelvedata',
  EURUSD:  'twelvedata',
  GBPUSD:  'twelvedata',
  USDJPY:  'twelvedata',
  GBPJPY:  'twelvedata',
  EURGBP:  'twelvedata',
  EURJPY:  'twelvedata',
  US500:   'twelvedata',
  NAS100:  'twelvedata',
  USOIL:   'twelvedata',
  DXY:     'twelvedata',
}

/**
 * Carica candele storiche con cache e paginazione.
 * @param {string} symbol
 * @param {string} interval - '1h' | '4h' | '1D'
 * @param {number} years - quanti anni indietro
 * @param {string|null} apiKey - solo per TwelveData
 * @param {Function} onProgress - callback(message)
 */
export async function loadHistoricalCandles(symbol, interval = '1D', years = 5, apiKey = null, onProgress = null) {
  // Check cache
  const cached = loadFromCache(symbol, interval, years)
  if (cached && cached.length > 100) {
    if (onProgress) onProgress(`✓ Cache: ${cached.length} candele`)
    return { candles: cached, fromCache: true }
  }

  const source = ROUTING[symbol]
  if (!source) throw new Error(`Routing missing for ${symbol}`)

  if (onProgress) onProgress(`Caricamento ${years}y di ${symbol} ${interval} da ${source}...`)

  let candles = []
  if (source === 'binance') {
    candles = await fetchBinanceHistorical(symbol, interval, years)
  } else if (source === 'twelvedata') {
    if (!apiKey) throw new Error('TwelveData API key richiesta per ' + symbol)
    candles = await fetchTDHistorical(symbol, interval, years, apiKey)
  }

  if (candles.length > 100) {
    saveToCache(symbol, interval, years, candles)
  }

  if (onProgress) onProgress(`✓ Caricate ${candles.length} candele`)
  return { candles, fromCache: false }
}
