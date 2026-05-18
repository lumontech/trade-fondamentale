// Forex Factory economic calendar — via backend proxy del VPS.
// Sostituisce il vecchio corsproxy.io (che dava 403 sistematicamente).
// L'endpoint backend cache 15 min e usa user-agent Chrome per non essere bloccato.
const BACKEND_URL = '/api/macro/ff-calendar'    // same-origin

export async function fetchFFCalendar() {
  const res = await fetch(BACKEND_URL, { credentials: 'include' })
  if (!res.ok) {
    const txt = await res.text().catch(() => '')
    throw new Error(`FF backend HTTP ${res.status}: ${txt.slice(0, 100)}`)
  }
  const json = await res.json()
  if (json.error) throw new Error(json.error)
  const events = json.events || []
  return events.map(e => ({
    title:    e.title,
    currency: e.country,                       // USD, EUR, JPY...
    date:     new Date(e.date),                // ISO with timezone
    impact:   e.impact,                        // Holiday / Low / Medium / High
    forecast: e.forecast || '',
    previous: e.previous || '',
  }))
}

// Filter and group by day (local time)
export function groupByDay(events) {
  const groups = {}
  for (const e of events) {
    const key = e.date.toLocaleDateString('it-IT', {
      weekday: 'short', day: '2-digit', month: 'short',
    })
    if (!groups[key]) groups[key] = []
    groups[key].push(e)
  }
  return groups
}
