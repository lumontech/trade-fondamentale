// Binance REST + WebSocket — no API key required
const REST_BASE = 'https://api.binance.com/api/v3'

// Map internal symbol → Binance pair
const SYMBOL_MAP = {
  BTCUSD: 'BTCUSDT',
  ETHUSD: 'ETHUSDT',
  // Fix #5.7: Hyperliquid USDC perp pricing via Binance USDC spot/futures
  BTCUSDC: 'BTCUSDC',
  ETHUSDC: 'ETHUSDC',
  SOLUSDC: 'SOLUSDC',
  XRPUSDC: 'XRPUSDC',
  BNBUSDC: 'BNBUSDC',
}

const TF_MAP = {
  '1m': '1m', '5m': '5m', '15m': '15m',
  '1h': '1h', '4h': '4h', '1D': '1d',
}

export async function fetchBinanceCandles(symbol, interval, limit = 500) {
  const pair = SYMBOL_MAP[symbol] || symbol
  const tf   = TF_MAP[interval] || '1h'
  const url  = `${REST_BASE}/klines?symbol=${pair}&interval=${tf}&limit=${limit}`
  const res  = await fetch(url)
  if (!res.ok) throw new Error(`Binance REST error ${res.status}`)
  const data = await res.json()
  return data.map(k => ({
    time:   Math.floor(k[0] / 1000),
    open:   parseFloat(k[1]),
    high:   parseFloat(k[2]),
    low:    parseFloat(k[3]),
    close:  parseFloat(k[4]),
    volume: parseFloat(k[5]),
  }))
}

export async function fetchBinanceTicker(symbol) {
  const pair = SYMBOL_MAP[symbol] || symbol
  const res  = await fetch(`${REST_BASE}/ticker/24hr?symbol=${pair}`)
  if (!res.ok) throw new Error(`Binance ticker error ${res.status}`)
  const d = await res.json()
  return {
    price:  parseFloat(d.lastPrice),
    open:   parseFloat(d.openPrice),
    change: parseFloat(d.priceChange),
    pct:    parseFloat(d.priceChangePercent),
    volume: parseFloat(d.volume),
  }
}

// WebSocket kline stream — con reconnect automatico + watchdog
const activeStreams = new Map()  // key → { ws, watchdog, reconnectAttempts, ... }

const WATCHDOG_MS         = 90 * 1000   // se nessun messaggio entro 90s → reconnect
const RECONNECT_BASE_MS   = 1000
const RECONNECT_MAX_MS    = 30 * 1000

export function subscribeBinanceKline(symbol, interval, onCandle, onConnect, onDisconnect) {
  const pair = (SYMBOL_MAP[symbol] || symbol).toLowerCase()
  const tf   = TF_MAP[interval] || '1h'
  const key  = `${pair}_${tf}`

  // Chiudi stream esistente per questa chiave (cleanup totale)
  if (activeStreams.has(key)) {
    const prev = activeStreams.get(key)
    prev.closed = true
    if (prev.watchdog) clearTimeout(prev.watchdog)
    if (prev.reconnectTimer) clearTimeout(prev.reconnectTimer)
    try { prev.ws?.close() } catch {}
    activeStreams.delete(key)
  }

  const handle = {
    ws: null,
    closed: false,
    reconnectAttempts: 0,
    watchdog: null,
    reconnectTimer: null,
    lastMessageAt: 0,
  }

  const resetWatchdog = () => {
    if (handle.watchdog) clearTimeout(handle.watchdog)
    handle.watchdog = setTimeout(() => {
      if (handle.closed) return
      console.warn(`[Binance] Watchdog: nessun kline su ${key} da ${WATCHDOG_MS/1000}s → reconnect`)
      try { handle.ws?.close() } catch {}
      // L'onclose lancia il reconnect
    }, WATCHDOG_MS)
  }

  const scheduleReconnect = () => {
    if (handle.closed) return
    const delay = Math.min(RECONNECT_BASE_MS * Math.pow(2, handle.reconnectAttempts), RECONNECT_MAX_MS)
    handle.reconnectAttempts++
    console.warn(`[Binance] Reconnect ${key} in ${delay}ms (attempt ${handle.reconnectAttempts})`)
    handle.reconnectTimer = setTimeout(() => {
      if (!handle.closed) connect()
    }, delay)
  }

  const connect = () => {
    if (handle.closed) return
    const ws = new WebSocket(`wss://stream.binance.com:9443/ws/${pair}@kline_${tf}`)
    handle.ws = ws

    ws.onopen = () => {
      handle.reconnectAttempts = 0
      handle.lastMessageAt = Date.now()
      onConnect?.()
      resetWatchdog()
    }

    ws.onmessage = (event) => {
      handle.lastMessageAt = Date.now()
      resetWatchdog()
      try {
        const msg = JSON.parse(event.data)
        const k = msg.k
        if (!k) return
        onCandle({
          time:   Math.floor(k.t / 1000),
          open:   parseFloat(k.o),
          high:   parseFloat(k.h),
          low:    parseFloat(k.l),
          close:  parseFloat(k.c),
          volume: parseFloat(k.v),
          closed: k.x,
        })
      } catch (err) {
        console.warn('[Binance] parse error:', err.message)
      }
    }

    ws.onerror = (e) => {
      console.warn(`[Binance] WS error ${key}`, e)
    }

    ws.onclose = () => {
      if (handle.watchdog) { clearTimeout(handle.watchdog); handle.watchdog = null }
      onDisconnect?.()
      if (!handle.closed) scheduleReconnect()
    }
  }

  connect()
  activeStreams.set(key, handle)

  return () => {
    handle.closed = true
    if (handle.watchdog) clearTimeout(handle.watchdog)
    if (handle.reconnectTimer) clearTimeout(handle.reconnectTimer)
    try { handle.ws?.close() } catch {}
    activeStreams.delete(key)
  }
}

// Ritorna timestamp dell'ultimo messaggio ricevuto per uno stream (per debug/UI)
export function getBinanceStreamHealth(symbol, interval) {
  const pair = (SYMBOL_MAP[symbol] || symbol).toLowerCase()
  const tf   = TF_MAP[interval] || '1h'
  const key  = `${pair}_${tf}`
  const h    = activeStreams.get(key)
  if (!h) return null
  return {
    connected:        h.ws?.readyState === WebSocket.OPEN,
    lastMessageAt:    h.lastMessageAt,
    silentForMs:      h.lastMessageAt ? Date.now() - h.lastMessageAt : null,
    reconnectAttempts: h.reconnectAttempts,
  }
}

export function closeBinanceStream(symbol, interval) {
  const pair = (SYMBOL_MAP[symbol] || symbol).toLowerCase()
  const tf   = TF_MAP[interval] || '1h'
  const key  = `${pair}_${tf}`
  if (activeStreams.has(key)) {
    const h = activeStreams.get(key)
    h.closed = true
    if (h.watchdog) clearTimeout(h.watchdog)
    if (h.reconnectTimer) clearTimeout(h.reconnectTimer)
    try { h.ws?.close() } catch {}
    activeStreams.delete(key)
  }
}
