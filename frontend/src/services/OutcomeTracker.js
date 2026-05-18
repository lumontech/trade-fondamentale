// OutcomeTracker — monitora le decisioni aperte e le chiude automaticamente
// quando il prezzo realizza SL o TP. Manda notifica browser quando chiude.
import { getAllDecisions, closeDecision } from './TradeLog'
import { useAppStore }                    from '../store/store'

let watcherTimer = null
const recentlyClosed = new Set()  // evita doppie notifiche

// ── Browser notifications ────────────────────────────────────────
export async function requestNotificationPermission() {
  if (!('Notification' in window)) return 'unsupported'
  if (Notification.permission === 'granted') return 'granted'
  if (Notification.permission === 'denied')  return 'denied'
  const result = await Notification.requestPermission()
  return result
}

function notify(title, body, options = {}) {
  if (!('Notification' in window) || Notification.permission !== 'granted') return
  try {
    new Notification(title, { body, icon: '/vite.svg', ...options })
  } catch {}
}

// ── Trigger detection ────────────────────────────────────────────
/**
 * Controlla se il prezzo corrente di un asset ha toccato SL/TP della decisione.
 * Usa la candela in corso (high/low) per maggior precisione, fallback al last price.
 */
function checkTrigger(decision, candles, livePrice) {
  if (decision.status !== 'open') return null
  if (decision.suggestedSL == null) return null

  const last = candles?.[candles.length - 1]
  // High/low intra-candela = movimento reale del periodo. Last price = punto attuale.
  const high = last?.high ?? livePrice
  const low  = last?.low  ?? livePrice

  if (decision.direction === 'LONG') {
    // Conservativo: se entrambi SL e TP sono stati toccati nello stesso periodo,
    // assume SL hit prima (peggiore per noi)
    if (low <= decision.suggestedSL)            return { type: 'SL', price: decision.suggestedSL }
    if (high >= (decision.suggestedTP ?? Infinity)) return { type: 'TP', price: decision.suggestedTP }
  } else if (decision.direction === 'SHORT') {
    if (high >= decision.suggestedSL)           return { type: 'SL', price: decision.suggestedSL }
    if (low <= (decision.suggestedTP ?? -Infinity)) return { type: 'TP', price: decision.suggestedTP }
  }
  return null
}

/**
 * Ciclo di check di tutte le decisioni aperte.
 */
function checkAll() {
  const state = useAppStore.getState()
  const open = getAllDecisions().filter(d => d.status === 'open')
  if (open.length === 0) return

  for (const d of open) {
    if (recentlyClosed.has(d.id)) continue
    const inst = state.instruments[d.symbol]
    if (!inst) continue

    const trig = checkTrigger(d, inst.candles, inst.price)
    if (!trig) continue

    const note = trig.type === 'TP'
      ? `TP raggiunto automaticamente (${trig.price})`
      : `SL toccato automaticamente (${trig.price})`

    const ok = closeDecision(d.id, trig.price, note)
    if (ok) {
      recentlyClosed.add(d.id)
      const emoji = trig.type === 'TP' ? '🎯' : '🛑'
      const title = `${emoji} ${trig.type === 'TP' ? 'TAKE PROFIT' : 'STOP LOSS'} — ${d.symbol}`
      const body  = `${d.direction} chiuso a ${trig.price}. Entry ${d.entryPrice}.`
      notify(title, body, { tag: d.id, requireInteraction: false })
      // Pulisci recentlyClosed dopo 5 min (in caso si voglia riaprire stesso asset)
      setTimeout(() => recentlyClosed.delete(d.id), 5 * 60 * 1000)
    }
  }
}

const CHECK_INTERVAL_MS = 10_000  // 10s

export function startOutcomeTracker() {
  if (watcherTimer) return
  // Richiedi permissione notifiche al primo avvio (silenzioso se già concessa o negata)
  requestNotificationPermission()
  // Run subito + intervallo
  checkAll()
  watcherTimer = setInterval(checkAll, CHECK_INTERVAL_MS)
}

export function stopOutcomeTracker() {
  if (watcherTimer) clearInterval(watcherTimer)
  watcherTimer = null
}

// ── Track record per Claude self-improvement loop ────────────────
/**
 * Restituisce le ultime N decisioni chiuse, con outcome e contesto rilevante.
 * Utilizzato da Claude per imparare dai propri errori.
 */
export function getClaudeTrackRecord({ symbolFilter = null, limit = 20 } = {}) {
  const closed = getAllDecisions()
    .filter(d => d.status === 'closed')
    .filter(d => !symbolFilter || d.symbol === symbolFilter)
    .slice(0, limit)

  if (closed.length === 0) return null

  const records = closed.map(d => ({
    symbol:     d.symbol,
    direction:  d.direction,
    confidence: d.confidence,
    entry:      d.entryPrice,
    exit:       d.exitPrice,
    outcome:    d.pnl > 0 ? 'WIN' : 'LOSS',
    pnl_pct:    d.pnlPct != null ? Math.round(d.pnlPct * 100) / 100 : null,
    r_multiple: d.rMultiple != null ? Math.round(d.rMultiple * 100) / 100 : null,
    duration_h: Math.round((d.closedAt - d.openedAt) / 3600000 * 10) / 10,
    key_reasons: (d.reasons || []).slice(0, 3).map(r => r.label),
    notes:      d.notes || null,
    closed_at:  new Date(d.closedAt).toISOString(),
  }))

  // Aggrega
  const wins = records.filter(r => r.outcome === 'WIN').length
  const totalR = records.reduce((s, r) => s + (r.r_multiple || 0), 0)
  const winsByDir = {
    LONG:  records.filter(r => r.direction === 'LONG'  && r.outcome === 'WIN').length,
    SHORT: records.filter(r => r.direction === 'SHORT' && r.outcome === 'WIN').length,
  }
  const totalsByDir = {
    LONG:  records.filter(r => r.direction === 'LONG').length,
    SHORT: records.filter(r => r.direction === 'SHORT').length,
  }

  return {
    summary: {
      total:        records.length,
      win_rate:     records.length > 0 ? Math.round(wins / records.length * 100) : 0,
      avg_r:        records.length > 0 ? Math.round(totalR / records.length * 100) / 100 : 0,
      long_wr:      totalsByDir.LONG  > 0 ? Math.round(winsByDir.LONG  / totalsByDir.LONG  * 100) : null,
      short_wr:     totalsByDir.SHORT > 0 ? Math.round(winsByDir.SHORT / totalsByDir.SHORT * 100) : null,
    },
    recent_decisions: records,
  }
}
