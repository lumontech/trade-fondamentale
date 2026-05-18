// Twelve Data — free API key (800 credits/day, 8/minute)
// Register: https://twelvedata.com/register
const REST_BASE = 'https://api.twelvedata.com'

// ── Symbol map ────────────────────────────────────────────────────
export const TD_SYMBOLS = {
  XAUUSD: { symbol: 'XAU/USD',  type: 'commodity' },
  EURUSD: { symbol: 'EUR/USD',  type: 'forex' },
  GBPUSD: { symbol: 'GBP/USD',  type: 'forex' },
  USDJPY: { symbol: 'USD/JPY',  type: 'forex' },
  GBPJPY: { symbol: 'GBP/JPY',  type: 'forex' },
  EURGBP: { symbol: 'EUR/GBP',  type: 'forex' },
  EURJPY: { symbol: 'EUR/JPY',  type: 'forex' },
  // SPX/NDX/WTI/DXY not on TD free plan — using ETF proxies (same chart pattern)
  US500:  { symbol: 'SPY',      type: 'etf' },    // S&P 500 ETF
  NAS100: { symbol: 'QQQ',      type: 'etf' },    // Nasdaq 100 ETF
  USOIL:  { symbol: 'USO',      type: 'etf' },    // US Oil Fund ETF
  DXY:    { symbol: 'UUP',      type: 'etf' },    // Dollar Bull ETF
}

// ETF proxy label shown in chart toolbar (empty string = no label)
export const TD_ETF_LABEL = {
  US500:  'via SPY',
  NAS100: 'via QQQ',
  USOIL:  'via USO',
  DXY:    'via UUP',
}

// Priority order for initial price load
export const TD_PRIORITY = ['XAUUSD','EURUSD','US500','GBPUSD','USDJPY','NAS100','DXY','GBPJPY','USOIL']

const TF_MAP = {
  '1m': '1min', '5m': '5min', '15m': '15min',
  '1h': '1h',   '4h': '4h',  '1D':  '1day',
}

// ── Per-key rate limiter ──────────────────────────────────────────
// Ogni API key ha la sua finestra 7 crediti / 62s indipendente.
// Usando 2 key: 14 crediti totali in 62s, 1600 al giorno.
class KeyLimiter {
  constructor(key, maxCalls = 7, windowMs = 62000) {
    this.key      = key
    this.max      = maxCalls
    this.window   = windowMs
    this.storageKey = `td_rate_log_${this._keyHash(key)}`
    this.dailyKey   = `td_daily_${this._keyHash(key)}`
    this.log        = this._loadLog()
    this.dailyExhausted = this._loadDaily()
  }

  _keyHash(k) {
    // Hash leggero per non salvare la key in chiaro in sessionStorage
    let h = 0
    for (let i = 0; i < k.length; i++) h = ((h << 5) - h + k.charCodeAt(i)) | 0
    return Math.abs(h).toString(36).slice(0, 8)
  }

  _loadLog() {
    try {
      const raw = sessionStorage.getItem(this.storageKey)
      if (!raw) return []
      const now = Date.now()
      return JSON.parse(raw).filter(t => now - t < this.window)
    } catch { return [] }
  }

  _saveLog() {
    try { sessionStorage.setItem(this.storageKey, JSON.stringify(this.log)) } catch {}
  }

  _loadDaily() {
    try {
      const raw = localStorage.getItem(this.dailyKey)
      if (!raw) return null
      const obj = JSON.parse(raw)
      // Se è passato il midnight UTC, resetta
      const todayUtc = new Date().toISOString().slice(0, 10)
      if (obj.dateUtc !== todayUtc) return null
      return obj.exhaustedAt
    } catch { return null }
  }

  markDailyExhausted() {
    this.dailyExhausted = Date.now()
    try {
      const todayUtc = new Date().toISOString().slice(0, 10)
      localStorage.setItem(this.dailyKey, JSON.stringify({
        dateUtc: todayUtc, exhaustedAt: this.dailyExhausted
      }))
    } catch {}
  }

  isDailyExhausted() {
    if (!this.dailyExhausted) return false
    const todayUtc = new Date().toISOString().slice(0, 10)
    const exhDate = new Date(this.dailyExhausted).toISOString().slice(0, 10)
    if (todayUtc !== exhDate) {
      this.dailyExhausted = null
      try { localStorage.removeItem(this.dailyKey) } catch {}
      return false
    }
    return true
  }

  creditsAvailable() {
    if (this.isDailyExhausted()) return 0
    const now = Date.now()
    const valid = this.log.filter(t => now - t < this.window)
    return Math.max(0, this.max - valid.length)
  }

  consume(credits = 1) {
    const ts = Date.now()
    for (let i = 0; i < credits; i++) this.log.push(ts)
    this._saveLog()
  }

  reset() {
    this.log = []
    this.dailyExhausted = null
    try {
      sessionStorage.removeItem(this.storageKey)
      localStorage.removeItem(this.dailyKey)
    } catch {}
  }

  status() {
    const now = Date.now()
    const valid = this.log.filter(t => now - t < this.window)
    const oldest = valid.length > 0 ? Math.min(...valid) : null
    return {
      keyHash:           this._keyHash(this.key),
      creditsUsedInWindow: valid.length,
      creditsAvailable:    this.creditsAvailable(),
      maxPerWindow:        this.max,
      windowResetIn:       oldest ? Math.max(0, this.window - (now - oldest)) : 0,
      dailyExhausted:      this.isDailyExhausted(),
    }
  }
}

// ── Multi-key manager ──────────────────────────────────────────────
class TDKeyManager {
  constructor() {
    this.limiters = []   // KeyLimiter[]
    this.queue    = []
    this._pending = false
  }

  setKeys(keys) {
    // keys = array di string non vuote, deduplicate
    const filtered = (keys || []).filter(k => k && k.trim()).map(k => k.trim())
    const uniq = [...new Set(filtered)]
    // Mantieni le statistiche delle key esistenti, aggiungi nuove, rimuovi vecchie
    const newLimiters = uniq.map(k => {
      const existing = this.limiters.find(l => l.key === k)
      return existing || new KeyLimiter(k)
    })
    this.limiters = newLimiters
  }

  pickBestKey(neededCredits = 1) {
    // Preferisce la key con più crediti disponibili
    const candidates = this.limiters
      .map(l => ({ limiter: l, available: l.creditsAvailable() }))
      .filter(c => c.available >= neededCredits)
      .sort((a, b) => b.available - a.available)
    return candidates[0]?.limiter || null
  }

  request(fn, credits = 1, timeoutMs = 6000) {
    return new Promise((resolve, reject) => {
      const job = { fn, resolve, reject, credits, _resolved: false }
      // Hard timeout: se il job resta in coda > timeoutMs senza essere servito
      // (es. tutte le key daily-exhausted), rejecta con errore esplicito così
      // i chiamanti possono fallback su altre fonti (Yahoo). Senza questo, il
      // job potrebbe restare in coda per sempre.
      const timer = setTimeout(() => {
        if (!job._resolved) {
          job._resolved = true
          // Rimuovi dalla coda se ancora presente
          const idx = this.queue.indexOf(job)
          if (idx >= 0) this.queue.splice(idx, 1)
          reject(new Error('TD_QUEUE_TIMEOUT: no key available within ' + timeoutMs + 'ms (all daily-exhausted?)'))
        }
      }, timeoutMs)
      job.resolve = (val) => { if (!job._resolved) { job._resolved = true; clearTimeout(timer); resolve(val) } }
      job.reject  = (err) => { if (!job._resolved) { job._resolved = true; clearTimeout(timer); reject(err) } }
      this.queue.push(job)
      if (!this._pending) {
        this._pending = true
        Promise.resolve().then(() => { this._pending = false; this._flush() })
      }
    })
  }

  _flush() {
    while (this.queue.length > 0) {
      const job = this.queue[0]
      const lim = this.pickBestKey(job.credits)
      if (!lim) break    // Nessuna key disponibile, aspetta
      this.queue.shift()
      lim.consume(job.credits)
      // Esegui la fn passandole la key scelta
      job.fn(lim.key)
        .then(job.resolve)
        .catch(err => {
          // Detect daily quota exhausted dal messaggio.
          // Fix #5.12/5.13: distingui DAILY exhausted ("for the day") da MINUTE
          // rate-limit ("for the current minute"). Solo il daily marca la key come
          // exhausted persistente; il minute è transient e lascia la key valida.
          const msg = (err?.message || '').toLowerCase()
          const isDaily = (msg.includes('for the day') || msg.includes('daily limit') ||
                           msg.includes('daily quota') || msg.includes('limit exceeded for the day') ||
                           msg.includes('credit limit')) && !msg.includes('current minute') &&
                           !msg.includes('next minute')
          const isMinute = msg.includes('current minute') || msg.includes('next minute')
          if (isDaily) {
            lim.markDailyExhausted()
            // Se c'è un'altra key, riaccoda il job
            if (this.pickBestKey(job.credits)) {
              this.queue.unshift(job)
              setTimeout(() => this._flush(), 100)
              return
            }
          } else if (isMinute) {
            // Per-minute rate-limit: lascia la key valida, riaccoda dopo 8s
            // (il rate-limit log si svuota in <62s). Non rejectare.
            this.queue.unshift(job)
            setTimeout(() => this._flush(), 8000)
            return
          }
          job.reject(err)
        })
    }

    // Se ci sono job in coda e nessuna key disponibile, ritenta dopo il prossimo reset
    if (this.queue.length > 0) {
      const minWait = Math.min(...this.limiters
        .map(l => l.status().windowResetIn || l.window)
        .filter(t => t > 0)) + 500
      setTimeout(() => this._flush(), Math.min(minWait, 5000))
    }
  }

  status() {
    return {
      keys: this.limiters.map(l => l.status()),
      queueLength: this.queue.length,
      totalAvailable: this.limiters.reduce((s, l) => s + l.creditsAvailable(), 0),
      totalMax: this.limiters.reduce((s, l) => s + l.max, 0),
    }
  }

  reset() {
    this.limiters.forEach(l => l.reset())
    this.queue = []
  }
}

const keyManager = new TDKeyManager()

// ── Public key registration & diagnostics ──────────────────────────
export function setTDKeys(keys) {
  keyManager.setKeys(keys)
}

export function getTDRateLimitStatus() {
  return keyManager.status()
}

export function resetTDRateLimit() {
  keyManager.reset()
}

// ── REST core — usa la migliore key disponibile via keyManager ────
// L'URL deve contenere il placeholder ${APIKEY} che verrà sostituito
// con la key scelta dal manager al momento dell'esecuzione.
async function _get(urlBuilder, credits = 1) {
  return keyManager.request(async (apiKey) => {
    const url = typeof urlBuilder === 'function' ? urlBuilder(apiKey) : urlBuilder.replace('${APIKEY}', apiKey)
    const res  = await fetch(url)
    const data = await res.json()
    if (data.status === 'error') {
      const err = new Error(data.message)
      err.code = data.code
      throw err
    }
    return data
  }, credits)
}

// ── Time series (candles) ─────────────────────────────────────────
// Forziamo timezone=UTC: senza, TD restituisce in "Exchange time" (EDT per US),
// e il browser parsa "YYYY-MM-DD HH:MM:SS" come local time → orari sbagliati di 4-6h.
export async function fetchTDCandles(symbol, interval, apiKey, outputsize = 500) {
  const cfg = TD_SYMBOLS[symbol]
  if (!cfg) throw new Error(`Symbol not found: ${symbol}`)
  const tf  = TF_MAP[interval] || '1h'
  // L'apiKey passato è ignorato: il keyManager sceglie automaticamente la migliore disponibile
  const urlBuilder = (k) => `${REST_BASE}/time_series?symbol=${cfg.symbol}&interval=${tf}&outputsize=${outputsize}&timezone=UTC&apikey=${k}`
  const data = await _get(urlBuilder)
  if (!data.values) throw new Error('No candle data')
  return data.values.reverse().map(v => {
    // datetime è in UTC ma senza 'Z' — forziamo parse UTC
    const isoUtc = v.datetime.includes('T') ? v.datetime : v.datetime.replace(' ', 'T')
    const utcDt  = isoUtc.endsWith('Z') ? isoUtc : isoUtc + 'Z'
    return {
      time:   Math.floor(new Date(utcDt).getTime() / 1000),
      open:   parseFloat(v.open),
      high:   parseFloat(v.high),
      low:    parseFloat(v.low),
      close:  parseFloat(v.close),
      volume: parseFloat(v.volume || 0),
    }
  })
}

// ── Single price ──────────────────────────────────────────────────
export async function fetchTDPrice(symbol, apiKey) {
  const cfg = TD_SYMBOLS[symbol]
  if (!cfg) throw new Error(`Symbol not found: ${symbol}`)
  const urlBuilder = (k) => `${REST_BASE}/price?symbol=${cfg.symbol}&apikey=${k}`
  const data = await _get(urlBuilder)
  return parseFloat(data.price)
}

// ── Batch price (comma-separated, counts 1 credit per symbol) ────
// Returns { EURUSD: 1.0852, XAUUSD: 2045.5, ... }
export async function fetchTDBatchPrices(symbols, apiKey) {
  const tdSymList = symbols
    .map(s => TD_SYMBOLS[s]?.symbol)
    .filter(Boolean)
  if (!tdSymList.length) return {}

  // Do NOT use encodeURIComponent — commas must remain literal
  // Pass symbol count as credits so the limiter reserves the correct number of slots
  const urlBuilder = (k) => `${REST_BASE}/price?symbol=${tdSymList.join(',')}&apikey=${k}`
  const data = await _get(urlBuilder, tdSymList.length)

  const result = {}

  if (tdSymList.length === 1) {
    // Single-symbol response: { price: "1.0852" }
    const sym = symbols[0]
    if (data.price) result[sym] = parseFloat(data.price)
    return result
  }

  // Multi-symbol response: { "EUR/USD": { price: "1.0852" }, "XAU/USD": { price: "2045" }, ... }
  for (const sym of symbols) {
    const cfg = TD_SYMBOLS[sym]
    if (!cfg) continue
    const entry = data[cfg.symbol]
    if (entry?.price) result[sym] = parseFloat(entry.price)
  }
  return result
}

// ── WebSocket real-time quotes ────────────────────────────────────
let tdWs    = null
const tdSubs = new Map()  // internalSymbol → callback

export function connectTDWebSocket(apiKey, onStatus) {
  if (tdWs && tdWs.readyState === WebSocket.OPEN) return

  const ws = new WebSocket(`wss://ws.twelvedata.com/v1/quotes/price?apikey=${apiKey}`)
  tdWs = ws

  ws.onopen = () => {
    onStatus?.('connected')
    if (ws.readyState !== WebSocket.OPEN) return
    const syms = Array.from(tdSubs.keys())
      .map(s => TD_SYMBOLS[s]?.symbol).filter(Boolean).join(',')
    if (syms) ws.send(JSON.stringify({ action: 'subscribe', params: { symbols: syms } }))
  }

  ws.onmessage = (e) => {
    try {
      const msg = JSON.parse(e.data)
      if (msg.event !== 'price') return
      for (const [sym, cfg] of Object.entries(TD_SYMBOLS)) {
        if (cfg.symbol === msg.symbol) {
          tdSubs.get(sym)?.(parseFloat(msg.price))
          break
        }
      }
    } catch (_) {}
  }

  ws.onerror = () => onStatus?.('error')
  ws.onclose = () => { onStatus?.('disconnected'); if (tdWs === ws) tdWs = null }
}

export function subscribeTDPrice(symbol, callback) {
  tdSubs.set(symbol, callback)
  if (tdWs?.readyState === WebSocket.OPEN) {
    const sym = TD_SYMBOLS[symbol]?.symbol
    if (sym) tdWs.send(JSON.stringify({ action: 'subscribe', params: { symbols: sym } }))
  }
}

export function disconnectTDWebSocket() {
  tdWs?.close()
  tdWs = null
  tdSubs.clear()
}
