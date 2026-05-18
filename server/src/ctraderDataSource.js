// cTrader Open API data source — stub mode (no @himalaya-quant/ctrader-x)
// Il pacchetto cTrader non è disponibile nel deploy attuale (era una integrazione
// sperimentale non committata in package.json). Restano operativi gli altri
// data source: Yahoo, Finnhub, Binance, Hyperliquid.
//
// Per ripristinare cTrader full: aggiungere "@himalaya-quant/ctrader-x" alle
// dependencies di server/package.json e rimuovere il flag STUB sotto.
const STUB_MODE = true

// Stub minimale del client cTrader. Tutte le funzioni ritornano "not available".
const cTraderX = null
import { getValidAccessToken, loadTokens } from './ctraderAuth.js'

let _client = null
let _symbolsByName = null     // Map: 'EURUSD' → { symbolId, digits, pipPosition }
let _ready = false
let _initPromise = null

// Mapping timeframe a cTrader trendbar period (Spotware enum)
// M1=1, M2=2, M3=3, M4=4, M5=5, M10=6, M15=7, M30=8, H1=9, H4=10, H12=11, D1=12, W1=13, MN1=14
const TF_TO_CTRADER = {
  '1m':  'M1',
  '5m':  'M5',
  '15m': 'M15',
  '30m': 'M30',
  '1h':  'H1',
  '4h':  'H4',
  '1D':  'D1',
}

// Symbol name mapping: cTrader expone i simboli senza /
// Es. cTrader: 'EURUSD', 'XAUUSD'. Internal: stesso.
function normalizeName(symbol) {
  return symbol.replace('/', '').toUpperCase()
}

/**
 * Inizializza il client cTrader. Da chiamare all'avvio del server.
 * Se non c'è token → ritorna null (graceful, sim continua con TD).
 */
export async function initCtraderClient(env) {
  if (STUB_MODE) {
    console.log('[cTrader] STUB_MODE attivo — client cTrader disabilitato (pacchetto non installato)')
    return null
  }
  if (_initPromise) return _initPromise
  _initPromise = (async () => {
    try {
      const tokens = await loadTokens(env.DB)
      if (!tokens) {
        console.log('[cTrader] no OAuth token — client disabled (run /api/ctrader/auth/start)')
        return null
      }
      if (!tokens.account_id) {
        console.warn('[cTrader] token presente ma account_id non settato — fetch lista e scelgo primo')
        // TODO: fetch lista accounts e auto-select primo demo
      }
      const accessToken = await getValidAccessToken(env.DB, env)
      _client = new cTraderX({
        live: env.CTRADER_ENV === 'live',
        clientId: env.CTRADER_CLIENT_ID,
        clientSecret: env.CTRADER_CLIENT_SECRET,
        accessToken,
        ctidTraderAccountId: tokens.account_id,
        autoReconnect: true,
        reconnectIntervalMs: 5000,
        debug: false,
      })
      await _client.connect()
      console.log('[cTrader] connected — account', tokens.account_id, tokens.account_label || '')
      // Fetch lista simboli (cache locale)
      const symbols = await _client.symbols.getSymbolsList()
      _symbolsByName = new Map()
      for (const s of symbols) {
        _symbolsByName.set(normalizeName(s.symbolName), s)
      }
      console.log('[cTrader] symbols cached:', _symbolsByName.size)
      _ready = true
      return _client
    } catch (err) {
      console.error('[cTrader] init failed:', err.message)
      _client = null
      _ready = false
      return null
    }
  })()
  return _initPromise
}

export function isCtraderReady() {
  return _ready
}

/**
 * Fetcha candele storiche cTrader.
 * @param {string} symbol  es. 'EURUSD'
 * @param {string} tf      es. '15m', '4h'
 * @param {number} count   numero di bar (max ~5000)
 * @returns {Promise<Array<{time,open,high,low,close,volume}>>}
 */
export async function ctraderFetchCandles(symbol, tf, count = 200) {
  if (!_ready || !_client) throw new Error('cTrader client not ready')
  const ctraderTf = TF_TO_CTRADER[tf]
  if (!ctraderTf) throw new Error(`cTrader: unsupported timeframe ${tf}`)
  const sym = _symbolsByName.get(normalizeName(symbol))
  if (!sym) throw new Error(`cTrader: symbol not found ${symbol}`)

  const now = Date.now()
  // Window backward: count bar × TF duration (con margine)
  const tfMs = ({ '1m': 60_000, '5m': 300_000, '15m': 900_000, '30m': 1_800_000,
                  '1h': 3_600_000, '4h': 14_400_000, '1D': 86_400_000 })[tf] || 3_600_000
  const fromTs = now - count * tfMs

  const bars = await _client.bars.getHistoricalBars({
    symbolId: sym.symbolId,
    period: ctraderTf,
    fromTimestamp: fromTs,
    toTimestamp: now,
    count,
  })
  // Normalizza: { time (sec), o, h, l, c, v }
  // cTrader ritorna prezzi in "scaled" int (× 10^digits). Convertiamo.
  const scale = Math.pow(10, sym.digits || 5)
  return bars.map(b => ({
    time: Math.floor(b.utcTimestampInMinutes * 60),  // bar open in unix sec
    open: b.open / scale,
    high: b.high / scale,
    low:  b.low / scale,
    close: b.close / scale,
    volume: b.volume || 0,
  }))
}

/**
 * Ritorna lista simboli disponibili (cached).
 */
export function ctraderListSymbols() {
  if (!_ready || !_symbolsByName) return []
  return Array.from(_symbolsByName.values()).map(s => ({
    name: s.symbolName,
    id: s.symbolId,
    digits: s.digits,
    pipPosition: s.pipPosition,
  }))
}

/**
 * Subscribe live tick price per uno o più simboli.
 * @param {string[]} symbols
 * @param {(symbol, price) => void} onTick
 */
export async function ctraderSubscribeSpot(symbols, onTick) {
  if (!_ready || !_client) throw new Error('cTrader client not ready')
  const symbolIds = symbols.map(s => _symbolsByName.get(normalizeName(s))?.symbolId).filter(Boolean)
  if (!symbolIds.length) throw new Error('No valid symbols to subscribe')
  await _client.bars.subscribeLiveBars(symbolIds, 'M1', (bar) => {
    const symEntry = Array.from(_symbolsByName.values()).find(s => s.symbolId === bar.symbolId)
    if (!symEntry) return
    const scale = Math.pow(10, symEntry.digits || 5)
    onTick(symEntry.symbolName, bar.close / scale)
  })
}

export function ctraderDisconnect() {
  if (_client) {
    _client.disconnect()
    _client = null
    _ready = false
    _initPromise = null
  }
}
