// TradeLog — registro persistente delle decisioni operative di Claude.
// Ogni voce contiene snapshot completo (prezzo, scoring, contesto macro)
// + outcome quando viene chiusa (prezzo finale, P/L, R-multiple).
//
// Storage: hybrid
//   - localStorage (cache locale, sempre disponibile, no network latency)
//   - server-side via /api/user/trade-log (sync cross-device, persistente)
//
// Strategia di sync:
//   - Ogni write locale (logDecision/closeDecision/dismiss/delete) triggera
//     anche una fetch verso il server (best-effort, fire-and-forget).
//   - Al mount dell'app (AuthGuard), syncFromServer fa merge nel localStorage.
//   - LWW (last-write-wins) by updatedAt timestamp.

const STORAGE_KEY = 'itp_tradelog_v1'
const SERVER_URL  = '/api/user/trade-log'

function _load() {
  try { return JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]') }
  catch { return [] }
}
function _save(list) {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(list)) }
  catch {}
}

// ── Server sync helpers (best-effort, fire-and-forget) ──────────────
async function _serverUpsert(entry) {
  try {
    const res = await fetch(SERVER_URL, {
      method: 'PUT',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...entry, updatedAt: Date.now() }),
    })
    if (!res.ok && res.status !== 401) {
      console.warn('[TradeLog] server upsert failed:', res.status)
    }
  } catch (err) {
    console.warn('[TradeLog] server upsert error:', err.message)
  }
}

async function _serverDelete(id) {
  try {
    await fetch(`${SERVER_URL}/${encodeURIComponent(id)}`, {
      method: 'DELETE',
      credentials: 'include',
    })
  } catch (err) {
    console.warn('[TradeLog] server delete error:', err.message)
  }
}

/**
 * Pull dal server e merge nel localStorage.
 * Chiamato dall'AuthGuard dopo login + on app mount.
 * LWW merge: per ogni id, vince il record con updatedAt più alto.
 */
export async function syncFromServer({ since = 0, limit = 1000 } = {}) {
  try {
    const url = `${SERVER_URL}?since=${since}&limit=${limit}`
    const res = await fetch(url, { credentials: 'include' })
    if (!res.ok) {
      if (res.status !== 401) console.warn('[TradeLog] sync HTTP', res.status)
      return { synced: 0, error: 'http_' + res.status }
    }
    const data = await res.json()
    const remoteEntries = data.entries || []
    if (remoteEntries.length === 0) return { synced: 0 }

    const local = _load()
    const localById = Object.fromEntries(local.map(e => [e.id, e]))
    let added = 0, updated = 0
    for (const rem of remoteEntries) {
      const loc = localById[rem.id]
      if (!loc) {
        local.unshift(rem); added++
      } else if ((rem.updatedAt || 0) > (loc.updatedAt || 0)) {
        const idx = local.findIndex(e => e.id === rem.id)
        if (idx >= 0) { local[idx] = rem; updated++ }
      }
    }
    if (added || updated) {
      // Mantieni sort cronologico inverso
      local.sort((a, b) => (b.openedAt || 0) - (a.openedAt || 0))
      _save(local)
    }
    return { synced: added + updated, added, updated, total: remoteEntries.length }
  } catch (err) {
    console.warn('[TradeLog] sync error:', err.message)
    return { synced: 0, error: err.message }
  }
}

/**
 * Push completo: bulk upsert di tutto il localStorage al server.
 * Utile la prima volta (es. utente con dati locali da pre-feature).
 */
export async function pushAllToServer() {
  const list = _load()
  if (list.length === 0) return { pushed: 0 }
  try {
    const res = await fetch(`${SERVER_URL}/bulk`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ entries: list.map(e => ({ ...e, updatedAt: e.updatedAt || Date.now() })) }),
    })
    if (!res.ok) return { pushed: 0, error: 'http_' + res.status }
    const data = await res.json()
    return { pushed: data.saved || 0, total: data.total }
  } catch (err) {
    return { pushed: 0, error: err.message }
  }
}

/**
 * Registra una nuova decisione (snapshot del momento).
 * @returns {String} id della decisione creata
 */
export function logDecision(snapshot) {
  const list = _load()
  const id = `dec_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`
  const entry = {
    id,
    openedAt:    Date.now(),
    closedAt:    null,
    status:      'open',           // 'open' | 'closed' | 'dismissed'
    symbol:      snapshot.symbol,
    timeframe:   snapshot.timeframe,
    direction:   snapshot.direction,
    confidence:  snapshot.confidence,
    combined:    snapshot.combined,
    techScore:   snapshot.techScore,
    fundScore:   snapshot.fundScore,
    histScore:   snapshot.histScore,
    crossScore:  snapshot.crossScore,
    entryPrice:  snapshot.price,
    suggestedSL: snapshot.suggestedSL ?? null,
    suggestedTP: snapshot.suggestedTP ?? null,
    reasons:     snapshot.reasons || [],
    blockers:    snapshot.blockers || [],
    contextSnapshot: snapshot.context || null,
    exitPrice:   null,
    pnl:         null,
    pnlPct:      null,
    rMultiple:   null,
    notes:       '',
    mode:        snapshot.context?.analysis_mode || null,
    updatedAt:   Date.now(),
  }
  list.unshift(entry)
  _save(list)
  // Server sync best-effort (non blocca il return)
  _serverUpsert(entry)
  return id
}

export function closeDecision(id, exitPrice, notes = '') {
  const list = _load()
  const idx = list.findIndex(d => d.id === id)
  if (idx < 0) return false
  const d = list[idx]
  if (d.status !== 'open') return false
  const sign = d.direction === 'LONG' ? 1 : d.direction === 'SHORT' ? -1 : 0
  const pnl = sign * (exitPrice - d.entryPrice)
  const pnlPct = d.entryPrice !== 0 ? (pnl / d.entryPrice) * 100 : null
  let rMultiple = null
  if (d.suggestedSL != null) {
    const risk = Math.abs(d.entryPrice - d.suggestedSL)
    if (risk > 0) rMultiple = pnl / risk
  }
  const updated = {
    ...d,
    status:    'closed',
    closedAt:  Date.now(),
    exitPrice,
    pnl,
    pnlPct,
    rMultiple,
    notes,
    updatedAt: Date.now(),
  }
  list[idx] = updated
  _save(list)
  _serverUpsert(updated)
  return true
}

export function dismissDecision(id, notes = '') {
  const list = _load()
  const idx = list.findIndex(d => d.id === id)
  if (idx < 0) return false
  const updated = { ...list[idx], status: 'dismissed', closedAt: Date.now(), notes, updatedAt: Date.now() }
  list[idx] = updated
  _save(list)
  _serverUpsert(updated)
  return true
}

export function deleteDecision(id) {
  const list = _load().filter(d => d.id !== id)
  _save(list)
  _serverDelete(id)
}

/**
 * Correzione manuale dell'outcome del trade (sovrascrive auto-close del sistema).
 * Da usare quando l'OutcomeTracker — basato su candele Yahoo — diverge dal vero outcome
 * del broker (Yahoo lag/intra-bar ambiguity/divergenza tick-by-tick).
 *
 * @param {string} id            ID della decisione
 * @param {object} correction    { exitPrice, result: 'WIN'|'LOSS'|'BE'|null, notes }
 *                               Se `result` è impostato, il pnl viene calcolato in modo
 *                               coerente (LONG WIN = exit > entry, LONG LOSS = exit < entry).
 */
export function correctOutcome(id, { exitPrice, result, notes }) {
  const list = _load()
  const idx = list.findIndex(d => d.id === id)
  if (idx < 0) return false
  const d = list[idx]

  // Calcolo PnL/R-multiple corretti
  const sign = d.direction === 'LONG' ? 1 : d.direction === 'SHORT' ? -1 : 0
  const pnl = exitPrice != null ? sign * (exitPrice - d.entryPrice) : d.pnl
  const pnlPct = (pnl != null && d.entryPrice) ? (pnl / d.entryPrice) * 100 : null
  let rMultiple = null
  if (d.suggestedSL != null && pnl != null) {
    const risk = Math.abs(d.entryPrice - d.suggestedSL)
    if (risk > 0) rMultiple = pnl / risk
  }

  // Notes append: marca come correzione manuale per tracciabilità
  const correctionNote = `[MANUAL CORRECTION ${new Date().toLocaleString('it-IT')}] ` + (notes || '') +
    (result ? ` outcome=${result}` : '') +
    (exitPrice != null ? ` exit=${exitPrice}` : '')

  const updated = {
    ...d,
    status:      'closed',
    closedAt:    d.closedAt || Date.now(),
    exitPrice:   exitPrice ?? d.exitPrice,
    pnl,
    pnlPct,
    rMultiple,
    notes:       d.notes ? (d.notes + ' | ' + correctionNote) : correctionNote,
    manuallyCorrected: true,
    correctedAt: Date.now(),
    updatedAt:   Date.now(),
  }
  list[idx] = updated
  _save(list)
  _serverUpsert(updated)
  return updated
}

export function getAllDecisions() { return _load() }

export function getStats() {
  const all = _load()
  const closed = all.filter(d => d.status === 'closed' && d.direction !== 'FLAT')
  if (closed.length === 0) return null

  const wins  = closed.filter(d => d.pnl > 0).length
  const losses = closed.filter(d => d.pnl < 0).length
  const winRate = wins / closed.length
  const avgR = closed.filter(d => d.rMultiple != null)
                     .reduce((s, d) => s + d.rMultiple, 0) / Math.max(1, closed.filter(d => d.rMultiple != null).length)
  const totalPct = closed.reduce((s, d) => s + (d.pnlPct ?? 0), 0)
  const grossWin = closed.filter(d => d.pnl > 0).reduce((s, d) => s + d.pnl, 0)
  const grossLoss = Math.abs(closed.filter(d => d.pnl < 0).reduce((s, d) => s + d.pnl, 0))
  const profitFactor = grossLoss > 0 ? grossWin / grossLoss : (grossWin > 0 ? Infinity : 0)

  // Win rate per direzione
  const longTrades  = closed.filter(d => d.direction === 'LONG')
  const shortTrades = closed.filter(d => d.direction === 'SHORT')
  const longWR  = longTrades.length  > 0 ? longTrades.filter(d => d.pnl > 0).length  / longTrades.length  : null
  const shortWR = shortTrades.length > 0 ? shortTrades.filter(d => d.pnl > 0).length / shortTrades.length : null

  // Calibrazione confidence: per banda 50-70%, 70-85%, 85-100%
  const bands = [{label: '50-70%', min: 50, max: 70}, {label: '70-85%', min: 70, max: 85}, {label: '85-100%', min: 85, max: 101}]
  const calibration = bands.map(b => {
    const inBand = closed.filter(d => d.confidence >= b.min && d.confidence < b.max)
    return {
      ...b,
      count:   inBand.length,
      winRate: inBand.length > 0 ? inBand.filter(d => d.pnl > 0).length / inBand.length : null,
    }
  })

  return {
    total: closed.length, wins, losses, winRate, avgR, totalPct,
    profitFactor,
    longWR, longCount: longTrades.length,
    shortWR, shortCount: shortTrades.length,
    calibration,
    open: all.filter(d => d.status === 'open').length,
  }
}
