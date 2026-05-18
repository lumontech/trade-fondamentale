// WorkerSim — client del backend Node.js (sostituisce LiveSimulator.js client-side).
//
// Configurazione:
//   - VITE_WORKER_URL: URL del backend (vuoto = same-origin via Caddy)
//   - VITE_WORKER_AUTH: legacy Bearer token (NON piu' usato in Phase 3.1,
//                        l'auth e' cookie HttpOnly via /api/auth/login).
//                        Manteniamo il param solo per backward compat in
//                        scripts esterni eventuali — il browser usa cookie.
//
// Phase 3.1: tutte le fetch usano `credentials: 'include'` per inviare
// il cookie HttpOnly itp_session settato dal POST /api/auth/login.

const WORKER_URL  = import.meta.env.VITE_WORKER_URL || ''
const WORKER_AUTH = import.meta.env.VITE_WORKER_AUTH || ''

function url(path) {
  // Se WORKER_URL è vuoto → relative path (same-origin, server statico via Caddy)
  if (!WORKER_URL) return path
  return `${WORKER_URL.replace(/\/$/, '')}${path}`
}

// authFetch — wrapper di fetch che setta credentials:'include' (cookie auth)
// + headers minimi. Sostituisce TUTTE le fetch dirette in questo file.
function authFetch(path, opts = {}) {
  const headers = { ...(opts.headers || {}) }
  if (WORKER_AUTH && !headers['Authorization']) {
    // Backward compat: se VITE_WORKER_AUTH e' settato (deploy legacy)
    // lo includiamo, ma il backend Phase 3.1 ignora Bearer e usa solo cookie.
    headers['Authorization'] = `Bearer ${WORKER_AUTH}`
  }
  return fetch(url(path), {
    ...opts,
    credentials: 'include',
    headers,
  })
}

// ── Health / discovery ─────────────────────────────────────────────
export async function checkWorker() {
  try {
    const r = await authFetch('/api/health')
    if (!r.ok) return { ok: false, status: r.status }
    const data = await r.json()
    return { ok: true, ts: data.ts }
  } catch (err) {
    return { ok: false, error: err.message }
  }
}

// ── Profili (multi-profile) ────────────────────────────────────────
export async function fetchProfiles() {
  const r = await authFetch('/api/profiles')
  if (!r.ok) throw new Error(`Worker error ${r.status}`)
  const data = await r.json()
  return data.profiles || []
}

// ── State ──────────────────────────────────────────────────────────
export async function fetchWorkerState(profileId = 1) {
  const r = await authFetch(`/api/profiles/${profileId}/state`)
  if (!r.ok) {
    // Fallback al legacy /api/state per backward compat
    const r2 = await authFetch('/api/state')
    if (!r2.ok) throw new Error(`Worker error ${r2.status}`)
    return r2.json()
  }
  return r.json()
}

export async function fetchWorkerAccountDetail(key) {
  const r = await authFetch(`/api/accounts/${encodeURIComponent(key)}`)
  if (!r.ok) throw new Error(`Worker error ${r.status}`)
  return r.json()
}

// ── Lifecycle (profile-aware) ──────────────────────────────────────
export async function startWorkerSim(config, profileId = 1) {
  const r = await authFetch(`/api/profiles/${profileId}/start`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(config),
  })
  if (!r.ok) throw new Error(`start error ${r.status}: ${await r.text()}`)
  return r.json()
}

export async function stopWorkerSim(profileId = 1) {
  const r = await authFetch(`/api/profiles/${profileId}/stop`, { method: 'POST' })
  if (!r.ok) throw new Error(`stop error ${r.status}`)
  return r.json()
}

export async function resumeWorkerSim(profileId = 1) {
  const r = await authFetch(`/api/profiles/${profileId}/resume`, { method: 'POST' })
  if (!r.ok) throw new Error(`resume error ${r.status}`)
  return r.json()
}

export async function resetWorkerSim(profileId = 1) {
  const r = await authFetch(`/api/profiles/${profileId}/reset`, { method: 'POST' })
  if (!r.ok) throw new Error(`reset error ${r.status}`)
  return r.json()
}

// Forza un tick immediato (utile per debug, normalmente runs ogni minuto via cron)
export async function manualTick() {
  const r = await authFetch('/api/tick', { method: 'POST' })
  if (!r.ok) throw new Error(`tick error ${r.status}`)
  return r.json()
}

// ── Polling helper (profile-aware) ─────────────────────────────────
// Una mappa profileId -> { timer, listeners, lastState }
const _pollers = new Map()

export function subscribeWorkerState(cb, intervalMs = 5000, profileId = 1) {
  let p = _pollers.get(profileId)
  if (!p) {
    p = { listeners: new Set(), lastState: null, timer: null }
    _pollers.set(profileId, p)
  }
  p.listeners.add(cb)
  if (p.lastState) cb(p.lastState)
  if (!p.timer) {
    const tick = async () => {
      try {
        p.lastState = await fetchWorkerState(profileId)
        for (const fn of p.listeners) try { fn(p.lastState) } catch {}
      } catch (err) {
        console.warn(`[WorkerSim] poll error profile ${profileId}:`, err.message)
      }
    }
    tick()
    p.timer = setInterval(tick, intervalMs)
  }
  return () => {
    p.listeners.delete(cb)
    if (p.listeners.size === 0 && p.timer) {
      clearInterval(p.timer)
      p.timer = null
      _pollers.delete(profileId)
    }
  }
}

export function isWorkerConfigured() {
  // Same-origin (deployed con Caddy) o esplicito URL configurato
  return !!WORKER_URL || (typeof window !== 'undefined' && window.location.protocol === 'https:')
}

export function getWorkerUrl() {
  return WORKER_URL
}
