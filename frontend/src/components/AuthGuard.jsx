// AuthGuard — Phase 3.1 (server-side auth via cookie HttpOnly + bcrypt).
// Sostituisce la vecchia versione client-side con credenziali hardcoded
// (preservata in AuthGuard.legacy.jsx come storico).
//
// Flusso:
//   - mount → GET /api/auth/me (con credentials:include) per check sessione
//   - se 401 → mostra form login
//   - submit form → POST /api/auth/login → cookie itp_session HttpOnly settato
//   - logout → POST /api/auth/logout + reload
//
// Cache UX: sessionStorage (NON localStorage, no persist tra browser quit)
// memorizza solo {id,username,role} per evitare flash di "non loggato"
// al refresh. L'auth REALE e' il cookie HttpOnly (non leggibile da JS).
//
// Header.jsx importa { logout, getCurrentUser }: contratto preservato
// (getCurrentUser ritorna STRINGA username o null, identico al legacy).

import { useState, useEffect } from 'react'

const SESSION_KEY = 'itp_user_v2'   // sessionStorage cache UX (no auth source-of-truth)

// ── Public API (named exports per Header.jsx) ────────────────────────
export function getCurrentUser() {
  // Ritorna STRINGA username (backward compat con AuthGuard legacy).
  try {
    const raw = sessionStorage.getItem(SESSION_KEY)
    if (!raw) return null
    const u = JSON.parse(raw)
    return u?.username || null
  } catch { return null }
}

export async function logout() {
  try {
    await fetch('/api/auth/logout', { method: 'POST', credentials: 'include' })
  } catch { /* network error ok, comunque pulisco e reload */ }
  sessionStorage.removeItem(SESSION_KEY)
  window.location.reload()
}

// ── Component ────────────────────────────────────────────────────────
export default function AuthGuard({ children }) {
  const [state, setState] = useState({ loading: true, authed: false })
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState(null)
  const [showPwd, setShowPwd] = useState(false)
  const [submitting, setSubmitting] = useState(false)

  // ── On mount: verifica sessione + sync API keys server-side ─────
  useEffect(() => {
    let cancelled = false
    fetch('/api/auth/me', { credentials: 'include' })
      .then(r => r.ok ? r.json() : null)
      .then(async data => {
        if (cancelled) return
        if (data?.user?.username) {
          sessionStorage.setItem(SESSION_KEY, JSON.stringify(data.user))
          // Sync API keys dal server: appena sessione confermata, recupera le key
          // dell'utente da DB così se ha fatto login da un nuovo device le ritrova.
          try {
            const { useAppStore } = await import('../store/store')
            await useAppStore.getState().syncApiKeysFromServer?.()
          } catch (e) { console.warn('[AuthGuard] sync keys at mount:', e.message) }
          // Sync TradeLog dal server (Review Lab + Diario funzionano cross-device)
          try {
            const { syncFromServer } = await import('../services/TradeLog')
            const r = await syncFromServer({ limit: 1000 })
            if (r.synced > 0) console.log('[TradeLog] sync at mount:', r)
          } catch (e) { console.warn('[AuthGuard] sync trade log at mount:', e.message) }
          setState({ loading: false, authed: true })
        } else {
          sessionStorage.removeItem(SESSION_KEY)
          setState({ loading: false, authed: false })
        }
      })
      .catch(() => {
        if (cancelled) return
        sessionStorage.removeItem(SESSION_KEY)
        setState({ loading: false, authed: false })
      })
    return () => { cancelled = true }
  }, [])

  // ── Submit login form ────────────────────────────────────────────
  async function handleSubmit(e) {
    e.preventDefault()
    setError(null)
    if (!username || !password) {
      setError('Inserisci username e password')
      return
    }
    setSubmitting(true)
    try {
      const r = await fetch('/api/auth/login', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: username.trim(), password }),
      })
      const data = await r.json().catch(() => ({}))
      if (!r.ok) {
        if (data.error === 'too_many_attempts') {
          setError(`Troppi tentativi, riprova tra ${data.retryIn || '?'}s`)
        } else if (data.error === 'missing_credentials') {
          setError('Inserisci username e password')
        } else {
          setError('Credenziali non valide')
        }
        setPassword('')
        return
      }
      sessionStorage.setItem(SESSION_KEY, JSON.stringify(data.user))
      // Sync API keys dal server subito dopo il login esplicito
      try {
        const { useAppStore } = await import('../store/store')
        await useAppStore.getState().syncApiKeysFromServer?.()
      } catch (e) { console.warn('[AuthGuard] sync keys after login:', e.message) }
      // Sync TradeLog (Review Lab funziona cross-device)
      try {
        const { syncFromServer } = await import('../services/TradeLog')
        const r = await syncFromServer({ limit: 1000 })
        if (r.synced > 0) console.log('[TradeLog] sync after login:', r)
      } catch (e) { console.warn('[AuthGuard] sync trade log after login:', e.message) }
      setState({ loading: false, authed: true })
    } catch (err) {
      setError('Errore di rete — riprova')
    } finally {
      setSubmitting(false)
    }
  }

  // ── Render ───────────────────────────────────────────────────────
  if (state.loading) {
    return (
      <div className="h-screen w-screen flex items-center justify-center bg-bg-primary">
        <div className="font-mono text-xxs text-text-muted tracking-widest">CARICAMENTO…</div>
      </div>
    )
  }

  if (state.authed) return children

  return (
    <div className="h-screen w-screen flex items-center justify-center bg-bg-primary">
      <div className="w-full max-w-md p-8 bg-bg-secondary rounded-xl border border-bg-border">
        <div className="text-center mb-6">
          <div className="text-4xl mb-3">◈</div>
          <h1 className="font-mono text-2xl font-bold text-gold tracking-widest">IMPACT</h1>
          <p className="font-mono text-xxs text-text-muted tracking-widest mt-1">TRADING PLATFORM</p>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="block font-mono text-xxs text-text-muted uppercase tracking-wider mb-1.5">
              Username
            </label>
            <input
              type="text"
              autoComplete="username"
              value={username}
              onChange={e => setUsername(e.target.value)}
              autoFocus
              disabled={submitting}
              className="w-full bg-bg-primary border border-bg-border rounded-md px-3 py-2 font-mono text-sm text-text-primary focus:border-gold/50 outline-none disabled:opacity-50"
            />
          </div>

          <div>
            <label className="block font-mono text-xxs text-text-muted uppercase tracking-wider mb-1.5">
              Password
            </label>
            <div className="relative">
              <input
                type={showPwd ? 'text' : 'password'}
                autoComplete="current-password"
                value={password}
                onChange={e => setPassword(e.target.value)}
                disabled={submitting}
                className="w-full bg-bg-primary border border-bg-border rounded-md px-3 py-2 pr-10 font-mono text-sm text-text-primary focus:border-gold/50 outline-none disabled:opacity-50"
              />
              <button type="button"
                      onClick={() => setShowPwd(s => !s)}
                      tabIndex={-1}
                      className="absolute right-2 top-1/2 -translate-y-1/2 text-text-muted hover:text-text-primary text-sm">
                {showPwd ? '○' : '●'}
              </button>
            </div>
          </div>

          {error && (
            <div className="font-mono text-xs text-red bg-red/10 border border-red/30 rounded-md px-3 py-2">
              {error}
            </div>
          )}

          <button type="submit"
                  disabled={submitting}
                  className="w-full px-4 py-2.5 rounded-md font-mono text-sm font-semibold bg-gold/20 text-gold border border-gold/50 hover:bg-gold/30 transition-all disabled:opacity-50 disabled:cursor-not-allowed">
            {submitting ? 'Accesso in corso…' : 'Accedi'}
          </button>
        </form>

        <div className="mt-6 pt-4 border-t border-bg-border/50 text-center">
          <p className="font-mono text-xxs text-text-muted">
            Sessione 7 giorni. Logout dal menu in alto a destra.
          </p>
        </div>
      </div>
    </div>
  )
}
