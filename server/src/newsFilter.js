// News-event filter: scarica calendar Forex Factory + blocca apertura trade
// quando c'e evento alto impatto entro +/- 15min sul currency del pair.
// Cache eventi 1 ora (TTL = ~3600s).

const FF_URL = 'https://nfs.faireconomy.media/ff_calendar_thisweek.json'
const CACHE_TTL_SEC = 3600
const BLOCK_WINDOW_SEC = 15 * 60   // +/- 15 minuti

// Map currency -> pairs affetti (se EUR ha news, blocca tutti i pair con EUR)
const CURRENCY_TO_PAIRS = {
  USD: ['XAUUSD', 'EURUSD', 'GBPUSD', 'USDJPY', 'BTCUSD'],
  EUR: ['EURUSD', 'EURGBP', 'EURJPY'],
  GBP: ['GBPUSD', 'GBPJPY', 'EURGBP'],
  JPY: ['USDJPY', 'GBPJPY', 'EURJPY'],
  CHF: [],   // non tradiamo CHF
  AUD: [], NZD: [], CAD: [],
}

// Parse "this week" calendar Forex Factory format
function parseEvents(json) {
  if (!Array.isArray(json)) return []
  return json.map(e => ({
    title:    e.title,
    country:  e.country,           // 'USD', 'EUR', 'GBP', ...
    impact:   (e.impact || '').toLowerCase(),   // 'high' | 'medium' | 'low'
    date:     e.date,              // ISO 8601
    time:     e.time,
    timestamp: new Date(e.date).getTime() / 1000,
  })).filter(e => e.impact === 'high' && !isNaN(e.timestamp))
}

let _cache = { events: [], fetchedAt: 0 }

async function fetchEventsCached() {
  const now = Math.floor(Date.now() / 1000)
  if (now - _cache.fetchedAt < CACHE_TTL_SEC && _cache.events.length > 0) {
    return _cache.events
  }
  try {
    const res = await fetch(FF_URL, { headers: { 'User-Agent': 'ImpactTrading/1.0' } })
    if (!res.ok) throw new Error(`FF ${res.status}`)
    const json = await res.json()
    const events = parseEvents(json)
    _cache = { events, fetchedAt: now }
    return events
  } catch (err) {
    console.warn('[NewsFilter] fetch failed, using cache:', err.message)
    return _cache.events    // graceful fallback
  }
}

/**
 * Verifica se un pair e' "bloccato" dalla news per il timestamp dato.
 * @returns {{ blocked: boolean, reason?: string, eventTitle?: string }}
 */
export async function isBlockedByNews(symbol, timestampSec) {
  const events = await fetchEventsCached()
  if (events.length === 0) return { blocked: false }

  for (const event of events) {
    const diff = Math.abs(timestampSec - event.timestamp)
    if (diff > BLOCK_WINDOW_SEC) continue

    // Currency dell'evento -> pair affetti
    const affectedPairs = CURRENCY_TO_PAIRS[event.country] || []
    if (affectedPairs.includes(symbol)) {
      const minutesUntil = Math.round((event.timestamp - timestampSec) / 60)
      const tense = minutesUntil > 0 ? `tra ${minutesUntil}min` : `${-minutesUntil}min fa`
      return {
        blocked: true,
        reason: `News alto impatto ${event.country} ${tense}`,
        eventTitle: event.title,
      }
    }
  }
  return { blocked: false }
}

// Versione sincrona basata su cache (per uso in tight loop senza await)
export function isBlockedByNewsSync(symbol, timestampSec) {
  if (_cache.events.length === 0) return { blocked: false }
  for (const event of _cache.events) {
    const diff = Math.abs(timestampSec - event.timestamp)
    if (diff > BLOCK_WINDOW_SEC) continue
    const affectedPairs = CURRENCY_TO_PAIRS[event.country] || []
    if (affectedPairs.includes(symbol)) {
      return {
        blocked: true,
        reason: `News ${event.country}: ${event.title}`,
      }
    }
  }
  return { blocked: false }
}

/**
 * Pre-fetch eventi (chiamato all'avvio del server e ogni ora dal cron)
 */
export async function refreshNewsCache() {
  await fetchEventsCached()
  return _cache.events.length
}

export function getNewsCacheStats() {
  return {
    cached: _cache.events.length,
    fetchedAt: _cache.fetchedAt,
    age: Math.floor(Date.now() / 1000) - _cache.fetchedAt,
  }
}
