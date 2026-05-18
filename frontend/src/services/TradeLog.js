// TradeLog — registro persistente delle decisioni operative di Claude.
// Ogni voce contiene snapshot completo (prezzo, scoring, contesto macro)
// + outcome quando viene chiusa (prezzo finale, P/L, R-multiple).
// Storage: localStorage.

const STORAGE_KEY = 'itp_tradelog_v1'

function _load() {
  try { return JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]') }
  catch { return [] }
}
function _save(list) {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(list)) }
  catch {}
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
  }
  list.unshift(entry)
  _save(list)
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
  list[idx] = {
    ...d,
    status:    'closed',
    closedAt:  Date.now(),
    exitPrice,
    pnl,
    pnlPct,
    rMultiple,
    notes,
  }
  _save(list)
  return true
}

export function dismissDecision(id, notes = '') {
  const list = _load()
  const idx = list.findIndex(d => d.id === id)
  if (idx < 0) return false
  list[idx] = { ...list[idx], status: 'dismissed', closedAt: Date.now(), notes }
  _save(list)
  return true
}

export function deleteDecision(id) {
  const list = _load().filter(d => d.id !== id)
  _save(list)
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
