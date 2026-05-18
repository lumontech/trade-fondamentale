// ScheduledAnalyses — gestisce analisi Claude programmate per un orario futuro.
// Use case: Claude dice "alle 18:00 c'è NFP, aspetta dopo l'evento".
// → schedule automatico: nuova analisi alle 18:30 con notifica browser.
//
// Persistenza: localStorage (sopravvive a refresh)
// Trigger: setInterval ogni 30 secondi check pending
import { askClaude } from './ClaudeService'
import { buildContextPack }   from './ContextPack'
import { getClaudeTrackRecord } from './OutcomeTracker'
import { useAppStore } from '../store/store'
import { loadCandles, loadMultiTFCandles } from './DataHub'

const STORAGE_KEY = 'itp_scheduled_analyses_v1'

function _load() {
  try { return JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]') }
  catch { return [] }
}
function _save(list) {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(list)) }
  catch {}
}

/**
 * Aggiungi un'analisi programmata.
 * @param {Object} schedule - { symbol, timeframe, scheduledAt (ms), reason, styleProfile }
 */
export function addScheduledAnalysis({ symbol, timeframe, scheduledAt, reason, styleProfile = 'moderate' }) {
  const list = _load()
  const id = `sched_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`
  list.push({
    id,
    symbol, timeframe, scheduledAt,
    reason: reason || 'Analisi programmata',
    styleProfile,
    status: 'pending',     // 'pending' | 'running' | 'completed' | 'failed'
    createdAt: Date.now(),
    result: null,
    error: null,
  })
  _save(list)
  return id
}

export function getScheduledAnalyses() { return _load() }

export function deleteScheduledAnalysis(id) {
  const list = _load().filter(s => s.id !== id)
  _save(list)
}

/**
 * Riprova una schedulazione fallita (la riporta in pending).
 */
export function retryScheduledAnalysis(id) {
  const list = _load()
  const idx = list.findIndex(s => s.id === id)
  if (idx < 0) return
  list[idx] = { ...list[idx], status: 'pending', error: null, scheduledAt: Date.now() }
  _save(list)
}

export function updateScheduledAnalysis(id, updates) {
  const list = _load()
  const idx = list.findIndex(s => s.id === id)
  if (idx < 0) return
  list[idx] = { ...list[idx], ...updates }
  _save(list)
}

// Browser notification
function notify(title, body) {
  if (!('Notification' in window) || Notification.permission !== 'granted') return
  try { new Notification(title, { body, icon: '/vite.svg' }) } catch {}
}

// Esegue una analisi programmata.
// IMPORTANTE: il simbolo target potrebbe NON essere quello attualmente attivo
// (es. utente sta guardando BTC ma ha programmato un'analisi su XAU).
// Carichiamo quindi le candele del simbolo target ON-DEMAND prima di costruire il context.
async function runScheduled(sched) {
  let state = useAppStore.getState()
  if (!state.apiKeys.anthropic) {
    updateScheduledAnalysis(sched.id, { status: 'failed', error: 'No Anthropic API key' })
    return
  }
  updateScheduledAnalysis(sched.id, { status: 'running' })

  try {
    // 1. Verifica/carica candele principali per il simbolo+TF target
    let inst = state.instruments[sched.symbol]
    const needsLoad = !inst?.candles?.length
    if (needsLoad) {
      const result = await loadCandles(sched.symbol, sched.timeframe)
      if (result?.error) {
        updateScheduledAnalysis(sched.id, {
          status: 'failed',
          error: `Caricamento candele fallito: ${result.error}`
        })
        return
      }
      // Refresh state dopo caricamento
      state = useAppStore.getState()
      inst  = state.instruments[sched.symbol]
    }

    // 2. Carica anche multi-TF (per MTF confluence) — best-effort
    const mtfTFs = inst?.mtf || {}
    const mtfMissing = !mtfTFs['15m']?.length || !mtfTFs['1h']?.length || !mtfTFs['4h']?.length || !mtfTFs['1D']?.length
    if (mtfMissing) {
      try { await loadMultiTFCandles(sched.symbol) } catch (_) {}
      state = useAppStore.getState()
    }

    // 3. Verifica finale
    const finalInst = state.instruments[sched.symbol]
    if (!finalInst?.candles?.length) {
      updateScheduledAnalysis(sched.id, {
        status: 'failed',
        error: `Candele non disponibili per ${sched.symbol} ${sched.timeframe}. Verifica API key (TwelveData) o connessione.`
      })
      return
    }

    // 4. Costruisci context pack con dati freschi
    const ctx = buildContextPack({
      symbol:        sched.symbol,
      timeframe:     sched.timeframe,
      instruments:   state.instruments,
      events:        state.events,
      marketContext: state.marketContext,
      cot:           state.cot[sched.symbol] || null,
      news:          state.news,
      now:           new Date(),
    })
    if (!ctx) {
      updateScheduledAnalysis(sched.id, {
        status: 'failed',
        error: 'Context pack vuoto dopo caricamento candele (anomalia)'
      })
      return
    }

    // 5. Chiedi a Claude
    const tr  = getClaudeTrackRecord({ limit: 20 })
    const out = await askClaude(ctx, state.apiKeys.anthropic, 'claude-opus-4-7', tr, sched.styleProfile)

    updateScheduledAnalysis(sched.id, {
      status:      'completed',
      result:      out.decision,
      completedAt: Date.now(),
      tokens:      out.usage,
    })
    const dir = out.decision.direction
    const emoji = dir === 'LONG' ? '▲' : dir === 'SHORT' ? '▼' : '■'
    notify(
      `${emoji} ${dir} ${sched.symbol} • ${out.decision.confidence}%`,
      `Analisi programmata pronta: ${(out.decision.reasoning || '').slice(0, 120)}`
    )
  } catch (err) {
    updateScheduledAnalysis(sched.id, { status: 'failed', error: err.message })
  }
}

let watcherTimer = null
const CHECK_INTERVAL = 30 * 1000   // 30s

function checkPending() {
  const now = Date.now()
  const pending = _load().filter(s => s.status === 'pending' && s.scheduledAt <= now)
  for (const sched of pending) {
    runScheduled(sched).catch(() => {})
  }
}

export function startScheduledAnalysesWatcher() {
  if (watcherTimer) return
  // Richiedi permission notifiche
  if ('Notification' in window && Notification.permission === 'default') {
    Notification.requestPermission().catch(() => {})
  }
  // Run subito + intervallo
  checkPending()
  watcherTimer = setInterval(checkPending, CHECK_INTERVAL)
}

export function stopScheduledAnalysesWatcher() {
  if (watcherTimer) clearInterval(watcherTimer)
  watcherTimer = null
}

/**
 * Auto-suggest schedule: dato un context pack, identifica eventi imminenti
 * e suggerisce un'analisi 15 min dopo l'evento.
 * @returns {Array} suggerimenti { time, reason, eventTitle }
 */
export function suggestSchedulesFromEvents(events, symbol, now = new Date()) {
  if (!events || events.length === 0) return []
  const SYMBOL_CURRENCIES = {
    EURUSD: ['EUR', 'USD'], GBPUSD: ['GBP', 'USD'], USDJPY: ['USD', 'JPY'],
    GBPJPY: ['GBP', 'JPY'], XAUUSD: ['USD'], BTCUSD: ['USD'],
    USOIL:  ['USD'], US500: ['USD'], NAS100: ['USD'], DXY: ['USD'],
  }
  const currencies = SYMBOL_CURRENCIES[symbol] || ['USD']
  const HOUR = 3600 * 1000
  return events
    .filter(e => e.date > now && e.date - now < 24 * HOUR)
    .filter(e => e.impact === 'High' && currencies.includes(e.currency))
    .slice(0, 3)
    .map(e => ({
      eventTitle: e.title,
      currency:   e.currency,
      eventTime:  e.date.getTime(),
      suggestedTime: e.date.getTime() + 15 * 60 * 1000,    // +15 min
      reason: `Post-evento: ${e.title} (${e.currency})`,
    }))
}
