// Hyperliquid Service — fetcher per i 230+ perp del DEX (HYPE token nativo + tutti gli altri)
// Endpoint pubblico, no auth: POST https://api.hyperliquid.xyz/info { type: candleSnapshot }

const TF_MAP = {
  '1m': '1m', '5m': '5m', '15m': '15m',
  '1h': '1h', '4h': '4h', '1D': '1d',
}

const SYMBOL_MAP = {
  HYPEUSDC: 'HYPE',
  BTCUSDC: 'BTC', ETHUSDC: 'ETH',
  SOLUSDC: 'SOL', XRPUSDC: 'XRP', BNBUSDC: 'BNB',
}

const TF_TO_SEC = {
  '1m': 60, '5m': 300, '15m': 900, '1h': 3600, '4h': 14400, '1D': 86400,
}

/**
 * Fetcha candle storiche per un perp Hyperliquid.
 * @param {string} symbol  es. 'HYPEUSDC' (mappato a coin = 'HYPE')
 * @param {string} interval  '1m'..'1D'
 * @param {number} limit  max candles
 */
export async function fetchHyperliquidCandles(symbol, interval, limit = 500) {
  const coin = SYMBOL_MAP[symbol]
  if (!coin) throw new Error(`Hyperliquid symbol mapping missing: ${symbol}`)
  const tf = TF_MAP[interval] || '1h'
  const tfSec = TF_TO_SEC[interval] || 3600
  const endTime = Date.now()
  const startTime = endTime - limit * tfSec * 1000
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

/**
 * Fetcha ticker (last price) per un perp Hyperliquid.
 * Usa allMids endpoint per snapshot di tutti i prezzi current.
 */
export async function fetchHyperliquidTicker(symbol) {
  const coin = SYMBOL_MAP[symbol]
  if (!coin) throw new Error(`Hyperliquid symbol mapping missing: ${symbol}`)
  const res = await fetch('https://api.hyperliquid.xyz/info', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'allMids' }),
  })
  if (!res.ok) throw new Error(`Hyperliquid ${res.status}`)
  const mids = await res.json()
  const price = parseFloat(mids[coin])
  if (isNaN(price)) throw new Error(`No price for ${coin}`)
  return { price, open: price }
}

/**
 * Subscribe a updates real-time per un perp Hyperliquid.
 * Strategia: polling allMids ogni 3s (più refresh candles via callback se serve).
 * Ritorna unsubscribe function.
 */
export function subscribeHyperliquidTicker(symbol, onPrice, onConnect, onDisconnect) {
  const coin = SYMBOL_MAP[symbol]
  if (!coin) {
    onDisconnect?.()
    return () => {}
  }
  let cancelled = false
  let consecutiveFails = 0
  const tick = async () => {
    if (cancelled) return
    try {
      const res = await fetch('https://api.hyperliquid.xyz/info', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'allMids' }),
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const mids = await res.json()
      const price = parseFloat(mids[coin])
      if (!isNaN(price)) {
        if (consecutiveFails > 0) onConnect?.()
        consecutiveFails = 0
        onPrice(price)
      }
    } catch (err) {
      consecutiveFails++
      if (consecutiveFails === 3) onDisconnect?.()
    }
  }
  onConnect?.()
  tick()
  const id = setInterval(tick, 3000)
  return () => { cancelled = true; clearInterval(id) }
}

/**
 * Subscribe candles Hyperliquid via WebSocket (NATIVE realtime).
 * Endpoint: wss://api.hyperliquid.xyz/ws
 * Channel: candle  → push update per ogni tick e nuova bar.
 * Reconnect automatico in caso di disconnessione.
 */
export function subscribeHyperliquidKline(symbol, interval, onCandle, onConnect, onDisconnect) {
  const coin = SYMBOL_MAP[symbol]
  if (!coin) {
    onDisconnect?.()
    return () => {}
  }
  const tf = TF_MAP[interval] || '1h'
  let ws = null
  let cancelled = false
  let reconnectTimer = null
  let pingTimer = null

  const connect = () => {
    if (cancelled) return
    ws = new WebSocket('wss://api.hyperliquid.xyz/ws')

    ws.addEventListener('open', () => {
      onConnect?.()
      // Subscribe al channel candle
      ws.send(JSON.stringify({
        method: 'subscribe',
        subscription: { type: 'candle', coin, interval: tf },
      }))
      // Keepalive ping ogni 30s (Hyperliquid WS richiede heartbeat)
      pingTimer = setInterval(() => {
        if (ws?.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ method: 'ping' }))
        }
      }, 30000)
    })

    ws.addEventListener('message', (e) => {
      try {
        const msg = JSON.parse(e.data)
        if (msg.channel === 'candle' && msg.data) {
          const k = msg.data
          onCandle({
            time: Math.floor(k.t / 1000),
            open: parseFloat(k.o),
            high: parseFloat(k.h),
            low:  parseFloat(k.l),
            close: parseFloat(k.c),
            volume: parseFloat(k.v || 0),
          })
        }
      } catch (err) {
        console.warn('[Hyperliquid WS] parse error:', err.message)
      }
    })

    ws.addEventListener('close', () => {
      if (pingTimer) { clearInterval(pingTimer); pingTimer = null }
      if (!cancelled) {
        onDisconnect?.()
        // Reconnect dopo 3s
        reconnectTimer = setTimeout(connect, 3000)
      }
    })

    ws.addEventListener('error', () => {
      // close handler farà il reconnect
    })
  }

  connect()

  return () => {
    cancelled = true
    if (reconnectTimer) clearTimeout(reconnectTimer)
    if (pingTimer) clearInterval(pingTimer)
    if (ws?.readyState === WebSocket.OPEN) {
      try {
        ws.send(JSON.stringify({
          method: 'unsubscribe',
          subscription: { type: 'candle', coin, interval: tf },
        }))
      } catch {}
      ws.close()
    }
  }
}

/**
 * Subscribe allMids stream WebSocket — push prezzi mid di tutti i perp.
 * Più efficiente del polling per ticker live di multipli simboli.
 */
export function subscribeHyperliquidAllMidsWS(onMids, onConnect, onDisconnect) {
  let ws = null
  let cancelled = false
  let reconnectTimer = null
  const connect = () => {
    if (cancelled) return
    ws = new WebSocket('wss://api.hyperliquid.xyz/ws')
    ws.addEventListener('open', () => {
      onConnect?.()
      ws.send(JSON.stringify({
        method: 'subscribe',
        subscription: { type: 'allMids' },
      }))
    })
    ws.addEventListener('message', (e) => {
      try {
        const msg = JSON.parse(e.data)
        if (msg.channel === 'allMids' && msg.data?.mids) {
          onMids(msg.data.mids)
        }
      } catch {}
    })
    ws.addEventListener('close', () => {
      if (!cancelled) {
        onDisconnect?.()
        reconnectTimer = setTimeout(connect, 3000)
      }
    })
  }
  connect()
  return () => {
    cancelled = true
    if (reconnectTimer) clearTimeout(reconnectTimer)
    if (ws?.readyState === WebSocket.OPEN) ws.close()
  }
}
