// FRED (Federal Reserve Economic Data) — yields, VIX, DXY
// Richiede API key gratuita: https://fredaccount.stlouisfed.org/apikey
// Via backend proxy del VPS (sostituisce corsproxy.io che dava 403 frequente).
// Il backend cache 15 min e usa la FRED_API_KEY del .env del server (se l'utente
// non specifica una key, fallback automatico al server).
const BACKEND_BASE = '/api/macro/fred'

// Series ID utili per trading macro
export const FRED_SERIES = {
  DGS10:     '10-Year Treasury Yield',
  DGS2:      '2-Year Treasury Yield',
  T10Y2Y:    '10Y-2Y Spread (recession indicator)',
  VIXCLS:    'VIX Volatility Index',
  DTWEXBGS:  'USD Trade Weighted Index',
  DCOILWTICO:'WTI Crude Oil Price',
  GOLDAMGBD228NLBM: 'Gold Fixing Price (London PM)',
}

async function _fredFetch(seriesId, apiKey, limit = 30) {
  // Costruisce URL backend. Se l'utente passa apiKey la inoltra come query;
  // altrimenti il backend usa la sua FRED_API_KEY env var.
  const qs = new URLSearchParams({ limit: String(limit) })
  if (apiKey) qs.set('api_key', apiKey)
  const url = `${BACKEND_BASE}/${encodeURIComponent(seriesId)}?${qs}`
  const res = await fetch(url, { credentials: 'include' })
  if (!res.ok) {
    const txt = await res.text().catch(() => '')
    throw new Error(`FRED backend HTTP ${res.status}: ${txt.slice(0, 100)}`)
  }
  const data = await res.json()
  if (data.error) throw new Error(data.error)
  if (!Array.isArray(data.observations)) throw new Error('FRED malformed response')
  return data.observations  // già {date, value} numerici dal backend
}

// Latest value + change vs previous
async function _fetchLatest(seriesId, apiKey) {
  const obs = await _fredFetch(seriesId, apiKey, 5)
  if (obs.length === 0) return null
  const latest = obs[0]
  const prev   = obs[1]
  return {
    value:    latest.value,
    date:     latest.date,
    prev:     prev?.value ?? null,
    change:   prev ? latest.value - prev.value : null,
    changePct: prev && prev.value !== 0 ? ((latest.value - prev.value) / Math.abs(prev.value)) * 100 : null,
  }
}

/**
 * Fetcha bundle macro completo: yields, VIX, DXY, oil, gold.
 * Ritorna oggetto con campi { us10y, us2y, spread10y2y, vix, dxy, oil, gold }
 */
export async function fetchMacroBundle(apiKey) {
  const [us10y, us2y, spread10y2y, vix, dxy] = await Promise.all([
    _fetchLatest('DGS10',     apiKey).catch(() => null),
    _fetchLatest('DGS2',      apiKey).catch(() => null),
    _fetchLatest('T10Y2Y',    apiKey).catch(() => null),
    _fetchLatest('VIXCLS',    apiKey).catch(() => null),
    _fetchLatest('DTWEXBGS',  apiKey).catch(() => null),
  ])
  return { us10y, us2y, spread10y2y, vix, dxy }
}
