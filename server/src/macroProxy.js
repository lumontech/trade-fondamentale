// macroProxy.js — proxy server-side per endpoint macro che bloccano CORS browser-side.
// Sostituisce corsproxy.io (che dà 403 frequentemente per rate-limit).
//
// Endpoint esposti:
//   GET /api/macro/ff-calendar   → ForexFactory weekly calendar (nfs.faireconomy.media)
//   GET /api/macro/fred/:series  → FRED series observations (DGS10, DGS2, T10Y2Y, DTWEXBGS, VIXCLS, ...)
//   GET /api/macro/fng           → Fear & Greed Index (alternative.me)
//
// Cache in-memory: 15 min per FF e FRED (refresh frequency vs API hammering),
// 30 min per F&G (cambia 1 volta al giorno).

const CACHE = new Map()  // key → { data, expiresAt }

function getCache(key) {
  const entry = CACHE.get(key)
  if (!entry) return null
  if (Date.now() > entry.expiresAt) { CACHE.delete(key); return null }
  return entry.data
}
function setCache(key, data, ttlSec) {
  CACHE.set(key, { data, expiresAt: Date.now() + ttlSec * 1000 })
}

// ── ForexFactory weekly calendar ─────────────────────────────────────
// Feed JSON ufficialmente mantenuto da faireconomy.media (pubblico, no key).
// Refresh frequency: ogni ~30 min server-side.
const FF_URL = 'https://nfs.faireconomy.media/ff_calendar_thisweek.json'
const FF_CACHE_TTL = 15 * 60  // 15 minuti

export async function fetchFFCalendar() {
  const cached = getCache('ff_calendar')
  if (cached) return { source: 'cache', ...cached }
  try {
    const res = await fetch(FF_URL, {
      headers: {
        // FF è schizzinoso con bot generici — user-agent realistico aiuta
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'application/json,text/plain,*/*',
      },
      // node-fetch 18+ ha timeout via AbortController
      signal: AbortSignal.timeout(15000),
    })
    if (!res.ok) {
      const text = await res.text().catch(() => '')
      throw new Error(`FF HTTP ${res.status}: ${text.slice(0, 100)}`)
    }
    const data = await res.json()
    const payload = { events: data, fetched_at: Date.now(), count: data.length }
    setCache('ff_calendar', payload, FF_CACHE_TTL)
    return { source: 'fresh', ...payload }
  } catch (err) {
    console.error('[macroProxy] FF fetch failed:', err.message)
    throw err
  }
}

// ── FRED (Federal Reserve Economic Data) ─────────────────────────────
// Richiede API key gratuita (https://fred.stlouisfed.org/docs/api/api_key.html)
// Series principali utili: DGS10 (US10Y), DGS2, T10Y2Y, DTWEXBGS (DXY broad), VIXCLS
const FRED_BASE = 'https://api.stlouisfed.org/fred/series/observations'
const FRED_CACHE_TTL = 15 * 60

export async function fetchFRED(seriesId, apiKey, limit = 5) {
  if (!apiKey) throw new Error('FRED_API_KEY missing')
  const cacheKey = `fred_${seriesId}_${limit}`
  const cached = getCache(cacheKey)
  if (cached) return { source: 'cache', ...cached }
  const url = `${FRED_BASE}?series_id=${encodeURIComponent(seriesId)}&api_key=${apiKey}&file_type=json&sort_order=desc&limit=${limit}`
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(10000) })
    if (!res.ok) {
      const text = await res.text().catch(() => '')
      throw new Error(`FRED HTTP ${res.status}: ${text.slice(0, 100)}`)
    }
    const data = await res.json()
    const obs = (data.observations || [])
      .map(o => ({ date: o.date, value: parseFloat(o.value) }))
      .filter(o => !isNaN(o.value))
    const payload = { series_id: seriesId, observations: obs, fetched_at: Date.now() }
    setCache(cacheKey, payload, FRED_CACHE_TTL)
    return { source: 'fresh', ...payload }
  } catch (err) {
    console.error(`[macroProxy] FRED ${seriesId} failed:`, err.message)
    throw err
  }
}

// ── Fear & Greed Index (CNN crypto index via alternative.me public API) ─
const FNG_URL = 'https://api.alternative.me/fng/?limit=1'
const FNG_CACHE_TTL = 30 * 60  // 30 min (cambia 1x al giorno)

export async function fetchFNG() {
  const cached = getCache('fng')
  if (cached) return { source: 'cache', ...cached }
  try {
    const res = await fetch(FNG_URL, { signal: AbortSignal.timeout(10000) })
    if (!res.ok) throw new Error(`FNG HTTP ${res.status}`)
    const data = await res.json()
    const item = data?.data?.[0]
    if (!item) throw new Error('FNG empty response')
    const payload = {
      value:           parseInt(item.value, 10),
      classification:  item.value_classification,
      timestamp:       parseInt(item.timestamp, 10) * 1000,
      fetched_at:      Date.now(),
    }
    setCache('fng', payload, FNG_CACHE_TTL)
    return { source: 'fresh', ...payload }
  } catch (err) {
    console.error('[macroProxy] FNG failed:', err.message)
    throw err
  }
}

// ── Hono route registration helper ───────────────────────────────────
export function registerMacroRoutes(app) {
  app.get('/api/macro/ff-calendar', async (c) => {
    try {
      const data = await fetchFFCalendar()
      return c.json(data)
    } catch (err) {
      return c.json({ error: err.message }, 502)
    }
  })

  app.get('/api/macro/fred/:series', async (c) => {
    const series = c.req.param('series')
    const limit  = Number(c.req.query('limit') || 5)
    const apiKey = c.req.query('api_key') || process.env.FRED_API_KEY
    try {
      const data = await fetchFRED(series, apiKey, limit)
      return c.json(data)
    } catch (err) {
      return c.json({ error: err.message, series }, 502)
    }
  })

  app.get('/api/macro/fng', async (c) => {
    try {
      const data = await fetchFNG()
      return c.json(data)
    } catch (err) {
      return c.json({ error: err.message }, 502)
    }
  })
}
