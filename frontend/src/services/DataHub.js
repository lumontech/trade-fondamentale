// Central data orchestrator — routes requests to the correct API source
import {
  fetchBinanceCandles,
  fetchBinanceTicker,
  subscribeBinanceKline,
} from './BinanceService'
import {
  fetchTDCandles,
  fetchTDPrice,
  fetchTDBatchPrices,
  connectTDWebSocket,
  subscribeTDPrice,
  disconnectTDWebSocket,
  TD_SYMBOLS,
  TD_PRIORITY,
  setTDKeys,
} from './TwelveDataService'
import {
  fetchHyperliquidCandles,
  fetchHyperliquidTicker,
  subscribeHyperliquidKline,
} from './HyperliquidService'
import { fetchYahooCandles, yahooSupports } from './YahooService'
import { useAppStore } from '../store/store'

// Sincronizza le key TD col keyManager. Da chiamare ogni volta che apiKeys cambia.
export function syncTDKeys() {
  const apiKeys = useAppStore.getState().apiKeys || {}
  const keys = [apiKeys.twelvedata, apiKeys.twelvedata2].filter(Boolean)
  setTDKeys(keys)
}

const ROUTING = {
  BTCUSD: 'binance',
  XAUUSD: 'twelvedata',
  EURUSD: 'twelvedata',
  GBPUSD: 'twelvedata',
  USDJPY: 'twelvedata',
  GBPJPY: 'twelvedata',
  EURGBP: 'twelvedata',
  EURJPY: 'twelvedata',
  US500:  'twelvedata',
  NAS100: 'twelvedata',
  USOIL:  'twelvedata',
  DXY:    'twelvedata',
  // Fix #5.7: Hyperliquid USDC perp — pricing via Binance USDC perp + native HYPE
  BTCUSDC:  'binance',
  ETHUSDC:  'binance',
  SOLUSDC:  'binance',
  XRPUSDC:  'binance',
  BNBUSDC:  'binance',
  HYPEUSDC: 'hyperliquid',
}

let activeUnsubscribe = null
let tdConnected       = false
let tdRefreshTimer    = null

// Timeframe → secondi
const TF_SECONDS = {
  '1m': 60, '5m': 300, '15m': 900,
  '1h': 3600, '4h': 14400, '1D': 86400,
}

function alignBarTime(nowSec, tfSec) {
  return Math.floor(nowSec / tfSec) * tfSec
}

// ── Load multi-timeframe candles per analisi confluence ──────────
// Default TF list per analisi intraday/swing (Murphy top-down).
const MTF_TIMEFRAMES = ['15m', '1h', '4h', '1D']
// TF aggiuntive per analisi scalping (1m + 5m + 15m + 1h).
export const SCALPING_TIMEFRAMES = ['1m', '5m', '15m', '1h']

/**
 * Carica le candele MTF per un symbol.
 * @param {string} symbol
 * @param {string[]} [tfs]  TF list (default: MTF_TIMEFRAMES per intraday).
 *                          Per scalping passare SCALPING_TIMEFRAMES.
 */
export async function loadMultiTFCandles(symbol, tfs = MTF_TIMEFRAMES) {
  const store  = useAppStore.getState()
  const source = ROUTING[symbol]
  const key    = source === 'twelvedata' ? store.apiKeys.twelvedata : null

  // Carica le TF in parallelo. Per twelvedata: se manca key o fallisce → Yahoo fallback.
  await Promise.allSettled(tfs.map(async tf => {
    try {
      let candles = []
      if (source === 'binance') {
        candles = await fetchBinanceCandles(symbol, tf, 200)
      } else if (source === 'twelvedata') {
        if (key) {
          try {
            candles = await Promise.race([
              fetchTDCandles(symbol, tf, key, 200),
              new Promise((_, rej) => setTimeout(() => rej(new Error('TD_MTF_TIMEOUT')), 7000)),
            ])
          } catch (e) {
            console.warn(`[DataHub] TD MTF ${symbol} ${tf} failed → yahoo:`, e.message)
          }
        }
        if (!candles?.length && yahooSupports(symbol)) {
          try { candles = await fetchYahooCandles(symbol, tf, 200) }
          catch (e) { console.warn(`[DataHub] Yahoo MTF ${symbol} ${tf} failed:`, e.message) }
        }
      } else if (source === 'hyperliquid') {
        candles = await fetchHyperliquidCandles(symbol, tf, 200)
      }
      if (candles?.length) {
        useAppStore.getState().setMTFCandles(symbol, tf, candles)
      }
    } catch (err) {
      console.warn(`[DataHub] MTF ${symbol} ${tf}:`, err.message)
    }
  }))
}

// ── Load historical candles (rate-limited via TDService queue) ────
export async function loadCandles(symbol, interval) {
  const store  = useAppStore.getState()
  const source = ROUTING[symbol]
  try {
    let candles = []
    if (source === 'binance') {
      candles = await fetchBinanceCandles(symbol, interval, 500)
    } else if (source === 'twelvedata') {
      const key = store.apiKeys.twelvedata
      // Tenta TD se c'è key, altrimenti vai diretto a Yahoo.
      if (key) {
        try {
          // Hard timeout 7s anche al livello DataHub (difesa in profondità — il
          // TDKeyManager dovrebbe rejectare a 6s, qui copriamo eventuali altri hang).
          candles = await Promise.race([
            fetchTDCandles(symbol, interval, key, 500),
            new Promise((_, rej) => setTimeout(() => rej(new Error('TD_DATAHUB_TIMEOUT')), 7000)),
          ])
        } catch (e) {
          console.warn(`[DataHub] TD ${symbol} ${interval} failed → yahoo:`, e.message)
        }
      }
      if (!candles?.length && yahooSupports(symbol)) {
        try {
          candles = await fetchYahooCandles(symbol, interval, 500)
        } catch (e) {
          console.warn(`[DataHub] Yahoo ${symbol} ${interval} failed:`, e.message)
        }
      }
      if (!candles?.length) {
        return { error: key ? 'TWELVE_DATA_AND_YAHOO_FAILED' : 'NO_TD_KEY_AND_YAHOO_FAILED' }
      }
    } else if (source === 'hyperliquid') {
      candles = await fetchHyperliquidCandles(symbol, interval, 500)
    }
    store.setCandles(symbol, candles)
    return { candles }
  } catch (err) {
    console.error(`[DataHub] loadCandles ${symbol}:`, err.message)
    return { error: err.message }
  }
}

// ── Subscribe to real-time updates ───────────────────────────────
export function subscribeRealtime(symbol, interval) {
  if (activeUnsubscribe) { activeUnsubscribe(); activeUnsubscribe = null }

  const store  = useAppStore.getState()
  const source = ROUTING[symbol]

  if (source === 'binance') {
    activeUnsubscribe = subscribeBinanceKline(
      symbol, interval,
      (candle) => { store.appendCandle(symbol, candle); store.updatePrice(symbol, candle.close, null) },
      () => store.setConnection('binance', 'connected'),
      () => store.setConnection('binance', 'disconnected'),
    )
  } else if (source === 'hyperliquid') {
    // Fix #5.7: Hyperliquid WebSocket nativo wss://api.hyperliquid.xyz/ws
    // Channel "candle" → push update live per ogni tick + nuova bar.
    activeUnsubscribe = subscribeHyperliquidKline(
      symbol, interval,
      (candle) => { store.appendCandle(symbol, candle); store.updatePrice(symbol, candle.close, null) },
      () => store.setConnection('hyperliquid', 'connected'),
      () => store.setConnection('hyperliquid', 'disconnected'),
    )
  } else if (source === 'twelvedata') {
    const key = store.apiKeys.twelvedata
    if (!key) return
    if (!tdConnected) {
      connectTDWebSocket(key, (status) => {
        store.setConnection('twelvedata', status)
        tdConnected = status === 'connected'
      })
    }

    // Tick price → aggiorna anche l'ultima candela (TD WS non manda candele)
    subscribeTDPrice(symbol, (price) => {
      const state = useAppStore.getState()
      state.updatePrice(symbol, price, null)

      const candles = state.instruments[symbol]?.candles
      if (!candles?.length) return
      const last = candles[candles.length - 1]
      const tfSec = TF_SECONDS[interval] || 3600
      const nowSec = Math.floor(Date.now() / 1000)
      const currentBarTime = alignBarTime(nowSec, tfSec)

      if (last.time === currentBarTime) {
        // Aggiorna candela in corso
        state.appendCandle(symbol, {
          ...last,
          close: price,
          high:  Math.max(last.high, price),
          low:   Math.min(last.low,  price),
        })
      } else if (currentBarTime > last.time) {
        // Apri nuova candela
        state.appendCandle(symbol, {
          time:   currentBarTime,
          open:   price,
          high:   price,
          low:    price,
          close:  price,
          volume: 0,
        })
      }
    })

    // Refresh periodico delle candele (90s) per recuperare gap se WS non manda tick
    if (tdRefreshTimer) clearInterval(tdRefreshTimer)
    tdRefreshTimer = setInterval(() => loadCandles(symbol, interval), 90 * 1000)

    activeUnsubscribe = () => {
      if (tdRefreshTimer) { clearInterval(tdRefreshTimer); tdRefreshTimer = null }
    }
  }
}

// ── Binance always-on ticker (BTC) ────────────────────────────────
export function initBinanceTicker() {
  const store = useAppStore.getState()
  subscribeBinanceKline(
    'BTCUSD', '1m',
    (candle) => store.updatePrice('BTCUSD', candle.close, null),
    () => store.setConnection('binance', 'connected'),
    () => store.setConnection('binance', 'disconnected'),
  )
}

// ── Initialize prices & WebSocket ────────────────────────────────
export async function initWatchlistPrices() {
  const store = useAppStore.getState()

  // BTC from Binance — instant
  try {
    const t = await fetchBinanceTicker('BTCUSD')
    store.updatePrice('BTCUSD', t.price, t.open)
    store.setConnection('binance', 'connected')
  } catch (_) { store.setConnection('binance', 'error') }

  const tdKey = store.apiKeys.twelvedata
  if (!tdKey) return

  // Batch first 7 symbols (max window allows). Rate limiter reserves 7 credits for this call.
  const firstBatch = TD_PRIORITY.slice(0, 7)
  try {
    const prices = await fetchTDBatchPrices(firstBatch, tdKey)
    for (const [sym, price] of Object.entries(prices)) {
      store.updatePrice(sym, price, null)
    }
    store.setConnection('twelvedata', 'connected')
  } catch (err) {
    console.warn('[DataHub] batch prices:', err.message)
    // Fallback: individual calls — rate limiter queues them until next window
    for (const sym of firstBatch) {
      fetchTDPrice(sym, tdKey)
        .then(price => useAppStore.getState().updatePrice(sym, price, null))
        .catch(() => {})
    }
  }

  // Remaining symbols — rate limiter queues these until the 62s window resets
  const remaining = TD_PRIORITY.slice(7)
  for (const sym of remaining) {
    fetchTDPrice(sym, tdKey)
      .then(price => useAppStore.getState().updatePrice(sym, price, null))
      .catch(() => {})
  }
}

// ── Connect Twelve Data WebSocket for real-time watchlist ─────────
export function initTwelveDataWS() {
  const store = useAppStore.getState()
  const key   = store.apiKeys.twelvedata
  if (!key || tdConnected) return

  connectTDWebSocket(key, (status) => {
    store.setConnection('twelvedata', status)
    tdConnected = status === 'connected'
  })

  Object.keys(TD_SYMBOLS).forEach(sym => {
    subscribeTDPrice(sym, (price) => {
      useAppStore.getState().updatePrice(sym, price, null)
    })
  })
}

export function disconnectAll() {
  if (activeUnsubscribe) activeUnsubscribe()
  disconnectTDWebSocket()
  tdConnected = false
}
