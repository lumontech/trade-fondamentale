// cTrader FIX 4.4 Quote Session client per FPMarkets.
//
// Connessione TLS al server quote (default live-uk-eqx-01.p.c-trader.com:5211).
// Flusso:
//   1. TLS connect
//   2. Logon (35=A) con ResetSeqNumFlag=Y, ResetSeqNumFlag=Y, EncryptMethod=0, HeartBtInt=30
//   3. Heartbeat ogni 30s + risposta a TestRequest (35=1)
//   4. SecurityListRequest (35=x) -> SecurityList (35=y) per build symbolName -> symbolId map
//   5. MarketDataRequest (35=V) per ogni simbolo, SubscriptionRequestType=1, MDEntryType=0,1 (bid+offer)
//   6. Snapshot (35=W) + Incremental (35=X) -> tick aggregator -> candele OHLCV in-memory
//
// Espone API sync per data.js#loadCandles:
//   ctraderFixGetCandles(symbol, tf, count) -> Array | null
//   ctraderFixIsReady() -> boolean
//   ctraderFixSubscribedSymbols() -> string[]
//
// Variabili env richieste:
//   CTRADER_FIX_HOST       (default: live-uk-eqx-01.p.c-trader.com)
//   CTRADER_FIX_PORT       (default: 5211)
//   CTRADER_FIX_USERNAME   (es. 2055134)
//   CTRADER_FIX_PASSWORD
//   CTRADER_FIX_SENDER     (es. live.fpmarkets.2055134)
//   CTRADER_FIX_TARGET     (default: cServer)
//   CTRADER_FIX_SUBID      (default: QUOTE)
//
// NOTE: FIX cTrader NON da' candele storiche. Da' SOLO tick bid/ask live.
// Le candele si costruiscono aggregando i tick in finestre temporali (1m, 5m, ...).
// Il sistema esistente continua a fornire la base storica via TwelveData/Yahoo;
// questo modulo aggiunge la "current bar" live tick-by-tick quando connesso.

import net from 'node:net'
import tls from 'node:tls'

const SOH = '\x01'

// FIX tag constants (https://www.onixs.biz/fix-dictionary/4.4/fields_by_tag.html)
const TAG = {
  BeginString: 8, BodyLength: 9, MsgType: 35, SenderCompID: 49, TargetCompID: 56,
  SenderSubID: 50, TargetSubID: 57, MsgSeqNum: 34, SendingTime: 52, CheckSum: 10,
  EncryptMethod: 98, HeartBtInt: 108, Username: 553, Password: 554, ResetSeqNumFlag: 141,
  TestReqID: 112, RefSeqNum: 45, Text: 58,
  // SecurityListRequest fields:
  //   320 SecurityReqID (the unique request ID we generate)
  //   559 SecurityListRequestType (0 = symbol, 4 = all securities)
  SecurityReqID: 320, SecurityListRequestType: 559, SecurityListResponseType: 322,
  Symbol: 55, SecurityID: 48, NoRelatedSym: 146,
  MDReqID: 262, SubscriptionRequestType: 263, MarketDepth: 264, MDUpdateType: 265,
  NoMDEntryTypes: 267, MDEntryType: 269, MDEntryPx: 270, MDEntrySize: 271,
  NoMDEntries: 268, MDUpdateAction: 279,
}

const MSG_TYPE = {
  Logon: 'A', Logout: '5', Heartbeat: '0', TestRequest: '1', ResendRequest: '2', Reject: '3',
  SequenceReset: '4', BusinessReject: 'j',
  SecurityListRequest: 'x', SecurityList: 'y',
  MarketDataRequest: 'V', MarketDataSnapshotFullRefresh: 'W',
  MarketDataIncrementalRefresh: 'X', MarketDataRequestReject: 'Y',
}

// FIX SendingTime: "YYYYMMDD-HH:MM:SS.sss" (UTC)
function fixSendingTime() {
  const d = new Date()
  const pad = (n, w = 2) => String(n).padStart(w, '0')
  return `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}-` +
         `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}.${pad(d.getUTCMilliseconds(), 3)}`
}

// Build FIX message. Returns string ending with SOH.
function buildFix(msgType, sessionFields, bodyFields) {
  // body = MsgType + sessionFields + bodyFields  (without BeginString, BodyLength, CheckSum)
  const sessionParts = [`${TAG.MsgType}=${msgType}`]
  for (const [tag, val] of sessionFields) sessionParts.push(`${tag}=${val}`)
  for (const [tag, val] of bodyFields)    sessionParts.push(`${tag}=${val}`)
  const body = sessionParts.join(SOH) + SOH
  const bodyLen = body.length
  const head = `${TAG.BeginString}=FIX.4.4${SOH}${TAG.BodyLength}=${bodyLen}${SOH}`
  const beforeChecksum = head + body
  // Checksum = sum of all bytes mod 256, 3-digit zero-padded
  let sum = 0
  for (let i = 0; i < beforeChecksum.length; i++) sum += beforeChecksum.charCodeAt(i)
  const cs = String(sum % 256).padStart(3, '0')
  return beforeChecksum + `${TAG.CheckSum}=${cs}${SOH}`
}

// Parse single FIX message string into {tag:value} map (last wins on dup)
function parseFix(msg) {
  const out = {}
  const parts = msg.split(SOH)
  for (const p of parts) {
    if (!p) continue
    const idx = p.indexOf('=')
    if (idx < 0) continue
    const t = Number(p.slice(0, idx))
    out[t] = p.slice(idx + 1)
  }
  return out
}

// Parse repeating-group "raw" view: returns array of {tag,value} in document order
function parseFixOrdered(msg) {
  const out = []
  const parts = msg.split(SOH)
  for (const p of parts) {
    if (!p) continue
    const idx = p.indexOf('=')
    if (idx < 0) continue
    out.push({ tag: Number(p.slice(0, idx)), value: p.slice(idx + 1) })
  }
  return out
}

// ── Module state ──────────────────────────────────────────────────
let _socket = null
let _config = null         // {host, port, username, password, sender, target, subid, ssl}
let _outSeq = 1            // sender seq num (we send)
let _inSeq = 0             // last seen incoming seq num
let _connected = false
let _loggedIn = false
let _hbTimer = null
let _reconnectTimer = null
let _reconnectAttempts = 0
let _recvBuf = ''
let _heartBtIntSec = 30

let _symbolByName = new Map()  // 'EURUSD' -> {id, name, digits}
let _symbolById   = new Map()  // 1 -> {id, name, digits}
let _securityListPending = false
let _securityListReqId = null

// In-memory tick + candle state per (symbol, tf)
//   _tickQuote['EURUSD'] = { bid: 1.0734, ask: 1.0735, ts: <unix sec> }
//   _candles['EURUSD']['1m'] = [{time, open, high, low, close, volume}, ...]
const _tickQuote = new Map()
const _candles = new Map()       // Map<symbol, Map<tf, Array<candle>>>
const TIMEFRAMES = ['1m', '5m', '15m', '1h', '4h', '1D']
const TF_SECONDS = { '1m': 60, '5m': 300, '15m': 900, '1h': 3600, '4h': 14400, '1D': 86400 }
const MAX_CANDLES_PER_TF = 600    // rolling window

// Simboli che vogliamo monitorare (devono esistere nel SecurityList del broker)
const WATCHED_SYMBOLS = [
  'EURUSD', 'GBPUSD', 'USDJPY', 'GBPJPY', 'EURGBP', 'EURJPY', 'XAUUSD',
]

// ── Public sync API ────────────────────────────────────────────────
export function ctraderFixIsReady() { return _connected && _loggedIn }
export function ctraderFixSubscribedSymbols() { return Array.from(_symbolByName.keys()) }

/**
 * Restituisce le ultime `count` candele in memoria per (symbol, tf), o null se non disponibili.
 */
export function ctraderFixGetCandles(symbol, tf, count = 500) {
  const tfMap = _candles.get(symbol)
  if (!tfMap) return null
  const arr = tfMap.get(tf)
  if (!arr || !arr.length) return null
  return arr.slice(-count)
}

export function ctraderFixGetCurrentQuote(symbol) {
  return _tickQuote.get(symbol) || null
}

// ── Connection lifecycle ──────────────────────────────────────────
export async function ctraderFixInit() {
  _reconnectEnabled = true
  const cfg = {
    host:     process.env.CTRADER_FIX_HOST || 'live-uk-eqx-01.p.c-trader.com',
    port:     Number(process.env.CTRADER_FIX_PORT || 5211),
    ssl:      String(process.env.CTRADER_FIX_SSL || '1') !== '0',
    username: process.env.CTRADER_FIX_USERNAME,
    password: process.env.CTRADER_FIX_PASSWORD,
    sender:   process.env.CTRADER_FIX_SENDER,
    target:   process.env.CTRADER_FIX_TARGET || 'cServer',
    subid:    process.env.CTRADER_FIX_SUBID  || 'QUOTE',
  }
  if (!cfg.username || !cfg.password || !cfg.sender) {
    console.warn('[FIX] missing CTRADER_FIX_USERNAME / _PASSWORD / _SENDER — FIX client disabled')
    return false
  }
  _config = cfg
  _connect()
  return true
}

function _connect() {
  if (_socket) { try { _socket.destroy() } catch {} _socket = null }
  _connected = false
  _loggedIn  = false
  _outSeq = 1
  _inSeq  = 0
  _recvBuf = ''

  const { host, port, ssl } = _config
  console.log(`[FIX] connecting to ${ssl ? 'tls' : 'tcp'}://${host}:${port}`)

  const onConnect = () => {
    _connected = true
    // NB: NON azzeriamo _reconnectAttempts qui — solo dopo Logon riuscito,
    // altrimenti se il server fa Logout subito (es. credenziali errate, SubID sbagliato),
    // entriamo in un loop di reconnect ogni 2s che si comporta come DOS attack.
    console.log('[FIX] socket connected, sending Logon...')
    _sendLogon()
  }

  if (ssl) {
    _socket = tls.connect({ host, port, servername: host, rejectUnauthorized: true }, onConnect)
  } else {
    _socket = net.createConnection({ host, port }, onConnect)
  }

  _socket.setKeepAlive(true, 30_000)
  _socket.setNoDelay(true)
  _socket.on('data', _onData)
  _socket.on('error', (err) => console.warn('[FIX] socket error:', err.message))
  _socket.on('close', () => {
    console.warn('[FIX] socket closed')
    _connected = false
    _loggedIn  = false
    if (_hbTimer) { clearInterval(_hbTimer); _hbTimer = null }
    _scheduleReconnect()
  })
}

let _reconnectEnabled = true

function _scheduleReconnect() {
  if (_reconnectTimer || !_reconnectEnabled) return
  // Backoff piu' aggressivo: 5s, 10s, 20s, 40s, 60s (max)
  const delay = Math.min(60_000, 5000 * Math.pow(2, Math.min(_reconnectAttempts, 4)))
  _reconnectAttempts++
  console.log(`[FIX] reconnect scheduled in ${delay}ms (attempt ${_reconnectAttempts})`)
  _reconnectTimer = setTimeout(() => {
    _reconnectTimer = null
    if (_reconnectEnabled) _connect()
  }, delay)
}

export function ctraderFixStop() {
  _reconnectEnabled = false
  if (_reconnectTimer) { clearTimeout(_reconnectTimer); _reconnectTimer = null }
  if (_hbTimer) { clearInterval(_hbTimer); _hbTimer = null }
  try { if (_socket && _loggedIn) _sendLogout('manual stop') } catch {}
  try { _socket?.destroy() } catch {}
  _socket = null
  _connected = false
  _loggedIn = false
  console.log('[FIX] manually stopped')
}

function _send(msg) {
  if (!_socket || !_connected) return false
  try {
    _socket.write(msg, 'utf8')
    return true
  } catch (e) {
    console.warn('[FIX] write error:', e.message)
    return false
  }
}

function _sessionHeaderFields(seqNum) {
  // cTrader expected field order — sorted by tag number, matching their FIX docs example:
  //   34 MsgSeqNum, 49 SenderCompID, 50 SenderSubID, 52 SendingTime, 56 TargetCompID, 57 TargetSubID
  return [
    [TAG.MsgSeqNum,    seqNum],
    [TAG.SenderCompID, _config.sender],
    [TAG.SenderSubID,  _config.subid],
    [TAG.SendingTime,  fixSendingTime()],
    [TAG.TargetCompID, _config.target],
    [TAG.TargetSubID,  _config.subid],
  ]
}

function _sendLogon() {
  const seq = _outSeq++
  const body = [
    [TAG.EncryptMethod,     0],
    [TAG.HeartBtInt,        _heartBtIntSec],
    [TAG.ResetSeqNumFlag,   'Y'],
    [TAG.Username,          _config.username],
    [TAG.Password,          _config.password],
  ]
  const msg = buildFix(MSG_TYPE.Logon, _sessionHeaderFields(seq), body)
  // Log con password mascherata per debug protocol issues
  const masked = msg.replace(/\x01554=[^\x01]+\x01/, `\x01554=***\x01`).replace(/\x01/g, '|')
  console.log(`[FIX] >> Logon: ${masked}`)
  _send(msg)
}

function _sendHeartbeat(testReqId) {
  const seq = _outSeq++
  const body = testReqId ? [[TAG.TestReqID, testReqId]] : []
  const msg = buildFix(MSG_TYPE.Heartbeat, _sessionHeaderFields(seq), body)
  _send(msg)
}

function _sendLogout(text) {
  if (!_connected) return
  const seq = _outSeq++
  const body = text ? [[TAG.Text, text]] : []
  const msg = buildFix(MSG_TYPE.Logout, _sessionHeaderFields(seq), body)
  _send(msg)
}

function _sendSecurityListRequest(symbolId) {
  const reqId = `SLR-${symbolId}-${Date.now()}`
  const seq = _outSeq++
  const body = [
    [TAG.SecurityReqID,            reqId],
    [TAG.SecurityListRequestType,  0],
    [TAG.Symbol,                   symbolId],
  ]
  const msg = buildFix(MSG_TYPE.SecurityListRequest, _sessionHeaderFields(seq), body)
  _send(msg)
}

function _sendMarketDataRequest(symbolId, mdReqId) {
  const seq = _outSeq++
  const body = [
    [TAG.MDReqID,                 mdReqId],
    [TAG.SubscriptionRequestType, 1],   // 1 = snapshot + updates
    [TAG.MarketDepth,             1],   // top of book
    [TAG.MDUpdateType,            0],   // 0 = full refresh on each update (semplifica parsing)
    [TAG.NoMDEntryTypes,          2],
    [TAG.MDEntryType,             0],   // bid
    [TAG.MDEntryType,             1],   // offer
    [TAG.NoRelatedSym,            1],
    [TAG.Symbol,                  symbolId],
  ]
  const msg = buildFix(MSG_TYPE.MarketDataRequest, _sessionHeaderFields(seq), body)
  _send(msg)
}

// ── Incoming data: framing + dispatch ──────────────────────────────
function _onData(chunk) {
  const txt = chunk.toString('binary')
  _recvBuf += txt
  while (true) {
    // Trova "8=FIX.4.4" all'inizio del buffer
    const bsi = _recvBuf.indexOf('8=FIX.4.4')
    if (bsi < 0) { _recvBuf = ''; return }
    if (bsi > 0) _recvBuf = _recvBuf.slice(bsi)

    // Trova BodyLength
    const blStart = _recvBuf.indexOf(`${SOH}${TAG.BodyLength}=`)
    if (blStart < 0) return
    const blValStart = blStart + 3
    const blEnd = _recvBuf.indexOf(SOH, blValStart)
    if (blEnd < 0) return
    const bodyLen = Number(_recvBuf.slice(blValStart, blEnd))
    if (!Number.isFinite(bodyLen) || bodyLen < 1) {
      // corrupt — discard one char and retry
      _recvBuf = _recvBuf.slice(1); continue
    }
    const bodyStart = blEnd + 1
    const bodyEnd   = bodyStart + bodyLen
    // CheckSum tag "10=NNN" + SOH = 7 chars
    const totalEnd  = bodyEnd + 7
    if (_recvBuf.length < totalEnd) return  // need more data

    const fullMsg = _recvBuf.slice(0, totalEnd)
    _recvBuf = _recvBuf.slice(totalEnd)
    _handleMessage(fullMsg)
  }
}

function _handleMessage(rawMsg) {
  const fields = parseFix(rawMsg)
  const type = fields[TAG.MsgType]
  const seq  = Number(fields[TAG.MsgSeqNum] || 0)
  if (seq > 0) _inSeq = Math.max(_inSeq, seq)

  switch (type) {
    case MSG_TYPE.Logon:
      _onLogon(fields)
      break
    case MSG_TYPE.Heartbeat:
      // server ack heartbeat — niente da fare
      break
    case MSG_TYPE.TestRequest:
      _sendHeartbeat(fields[TAG.TestReqID])
      break
    case MSG_TYPE.Logout:
      console.warn('[FIX] received Logout:', fields[TAG.Text] || '(no reason)')
      try { _socket?.end() } catch {}
      break
    case MSG_TYPE.Reject:
    case MSG_TYPE.BusinessReject:
      console.warn(`[FIX] reject type=${type} refSeq=${fields[TAG.RefSeqNum]} text=${fields[TAG.Text]}`)
      break
    case MSG_TYPE.SecurityList:
      _onSecurityList(rawMsg, fields)
      break
    case MSG_TYPE.MarketDataSnapshotFullRefresh:
    case MSG_TYPE.MarketDataIncrementalRefresh:
      _onMarketData(rawMsg, fields)
      break
    case MSG_TYPE.MarketDataRequestReject:
      console.warn(`[FIX] MDR reject: ${fields[TAG.MDReqID]} ${fields[TAG.Text] || ''}`)
      break
    default:
      // silently ignore other admin/business messages we don't need
      break
  }
}

function _onLogon(fields) {
  _loggedIn = true
  _reconnectAttempts = 0
  _heartBtIntSec = Number(fields[TAG.HeartBtInt] || _heartBtIntSec)
  console.log(`[FIX] Logon OK (HeartBtInt=${_heartBtIntSec}s)`)
  if (_hbTimer) clearInterval(_hbTimer)
  _hbTimer = setInterval(() => _sendHeartbeat(), _heartBtIntSec * 1000)
  // Marca tutti i WATCHED_SYMBOLS come "pending subscription" — saranno sottoscritti
  // automaticamente man mano che li scopriamo via SecurityList.
  _pendingSubscriptions = new Set(WATCHED_SYMBOLS)
  // Enumero ID 1..120 per coprire il catalogo FPMarkets (forex + metalli + indici + crypto).
  for (let id = 1; id <= 120; id++) {
    _sendSecurityListRequest(String(id))
  }
}

// Custom cTrader FIX tags:
//   1007 = symbol name (es. "EURUSD")
//   1008 = digits (precision)
const TAG_SYMBOL_NAME = 1007
const TAG_DIGITS = 1008

let _pendingSubscriptions = new Set()  // symbol names di cui aspettiamo l'ID

function _onSecurityList(rawMsg, fields) {
  const ordered = parseFixOrdered(rawMsg)
  let symbolId = null
  let name = null
  let digits = null
  for (const { tag, value } of ordered) {
    if (tag === TAG.Symbol) symbolId = value
    else if (tag === TAG_SYMBOL_NAME) name = value
    else if (tag === TAG_DIGITS) digits = Number(value)
  }
  if (!symbolId || !name) return
  const entry = { name, id: symbolId, digits }
  _symbolByName.set(name, entry)
  _symbolById.set(symbolId, entry)

  // Se questo simbolo è nella nostra watchlist E non l'abbiamo ancora sottoscritto, fallo ora
  if (WATCHED_SYMBOLS.includes(name) && _pendingSubscriptions.has(name)) {
    _pendingSubscriptions.delete(name)
    console.log(`[FIX] subscribing MarketData for ${name} (id=${symbolId}, digits=${digits})`)
    const reqId = `MD-${name}-${Date.now()}`
    _sendMarketDataRequest(symbolId, reqId)
  }
}

function _onMarketData(rawMsg, fields) {
  // Extract symbol (might be ID or name depending on broker)
  const symRef = fields[TAG.Symbol] || fields[TAG.SecurityID]
  if (!symRef) return
  // Risolvi name dal nostro map
  let symbolName = null
  const byId = _symbolById.get(symRef)
  if (byId) symbolName = byId.name
  else if (_symbolByName.has(symRef)) symbolName = symRef
  if (!symbolName) {
    // Some brokers echo back Symbol as the original name we sent
    symbolName = symRef
  }

  // Walk MD entries (repeating group):
  //   268 NoMDEntries
  //   269 MDEntryType (0=bid, 1=offer)
  //   270 MDEntryPx
  //   271 MDEntrySize
  const ordered = parseFixOrdered(rawMsg)
  let bid = null, ask = null
  let currentEntry = null
  for (const { tag, value } of ordered) {
    if (tag === TAG.MDEntryType) {
      currentEntry = { type: value, px: null }
    } else if (tag === TAG.MDEntryPx && currentEntry) {
      currentEntry.px = Number(value)
      if (currentEntry.type === '0') bid = currentEntry.px
      else if (currentEntry.type === '1') ask = currentEntry.px
    }
  }
  if (bid == null && ask == null) return

  // Aggiorna ultimo quote
  const tsSec = Math.floor(Date.now() / 1000)
  const prev = _tickQuote.get(symbolName) || {}
  const newQuote = { bid: bid ?? prev.bid, ask: ask ?? prev.ask, ts: tsSec }
  _tickQuote.set(symbolName, newQuote)

  // Aggrega come tick mid-price (avg bid/ask) per le candele
  if (newQuote.bid != null && newQuote.ask != null) {
    const mid = (newQuote.bid + newQuote.ask) / 2
    _updateCandles(symbolName, mid, tsSec)
  }
}

function _updateCandles(symbol, price, tsSec) {
  let tfMap = _candles.get(symbol)
  if (!tfMap) { tfMap = new Map(); _candles.set(symbol, tfMap) }
  for (const tf of TIMEFRAMES) {
    const tfSec = TF_SECONDS[tf]
    const barTime = Math.floor(tsSec / tfSec) * tfSec
    let arr = tfMap.get(tf)
    if (!arr) { arr = []; tfMap.set(tf, arr) }
    let last = arr.length ? arr[arr.length - 1] : null
    if (!last || last.time !== barTime) {
      // Nuova bar — chiude la precedente, apre la corrente
      const newBar = { time: barTime, open: price, high: price, low: price, close: price, volume: 1 }
      arr.push(newBar)
      if (arr.length > MAX_CANDLES_PER_TF) arr.splice(0, arr.length - MAX_CANDLES_PER_TF)
    } else {
      // Aggiorna bar corrente
      last.high = Math.max(last.high, price)
      last.low  = Math.min(last.low, price)
      last.close = price
      last.volume = (last.volume || 0) + 1
    }
  }
}

// Graceful shutdown
export function ctraderFixDisconnect() {
  _sendLogout('shutdown')
  if (_hbTimer) { clearInterval(_hbTimer); _hbTimer = null }
  if (_reconnectTimer) { clearTimeout(_reconnectTimer); _reconnectTimer = null }
  if (_socket) { try { _socket.destroy() } catch {} _socket = null }
  _connected = false
  _loggedIn  = false
}

export function ctraderFixStatus() {
  return {
    connected: _connected,
    logged_in: _loggedIn,
    out_seq: _outSeq,
    in_seq: _inSeq,
    securities: _symbolByName.size,
    quoting: _tickQuote.size,
    candles_symbols: _candles.size,
    reconnect_attempts: _reconnectAttempts,
  }
}
