// LEGACY — DO NOT USE.
// Vecchio AuthGuard client-side con credenziali HARDCODED nel bundle JS.
// Vulnerabilita': qualsiasi utente puo' aprire DevTools e leggere
// VALID_CREDENTIALS = { username:'stefano', password:'033614' }.
//
// Sostituito da AuthGuard.jsx che usa cookie HttpOnly + bcrypt server-side
// (Phase 3.1 — server/src/auth.js + endpoint /api/auth/*).
//
// Preservato come fallback storico/audit. NON importare in App.jsx.

import { useState, useEffect } from 'react'

const STORAGE_KEY = 'itp_auth_session_v1'
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000   // 7 giorni

// Credenziali valide. In production sara backend-side, qui MVP client.
const VALID_CREDENTIALS = [
  { username: 'stefano', password: '033614' },
]

function isAuthenticated() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return false
    const session = JSON.parse(raw)
    if (Date.now() - session.loginAt > SESSION_TTL_MS) {
      localStorage.removeItem(STORAGE_KEY)
      return false
    }
    return !!session.username
  } catch { return false }
}

function login(username, password) {
  const match = VALID_CREDENTIALS.find(
    c => c.username === username.trim().toLowerCase() && c.password === password
  )
  if (!match) return false
  localStorage.setItem(STORAGE_KEY, JSON.stringify({
    username: match.username,
    loginAt:  Date.now(),
  }))
  return true
}

export function logout() {
  localStorage.removeItem(STORAGE_KEY)
  window.location.reload()
}

export function getCurrentUser() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return null
    return JSON.parse(raw).username
  } catch { return null }
}

export default function AuthGuardLegacy({ children }) {
  const [authed, setAuthed] = useState(() => isAuthenticated())
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState(null)
  const [showPwd, setShowPwd] = useState(false)

  useEffect(() => {
    // Re-verifica sessione ogni minuto (TTL check)
    const id = setInterval(() => {
      if (!isAuthenticated()) setAuthed(false)
    }, 60_000)
    return () => clearInterval(id)
  }, [])

  if (authed) return children

  const handleSubmit = (e) => {
    e.preventDefault()
    setError(null)
    if (!username || !password) {
      setError('Inserisci username e password')
      return
    }
    const ok = login(username, password)
    if (ok) {
      setAuthed(true)
    } else {
      setError('Credenziali non valide')
      setPassword('')
    }
  }

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
              className="w-full bg-bg-primary border border-bg-border rounded-md px-3 py-2 font-mono text-sm text-text-primary focus:border-gold/50 outline-none"
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
                className="w-full bg-bg-primary border border-bg-border rounded-md px-3 py-2 pr-10 font-mono text-sm text-text-primary focus:border-gold/50 outline-none"
              />
              <button type="button"
                      onClick={() => setShowPwd(s => !s)}
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
                  className="w-full px-4 py-2.5 rounded-md font-mono text-sm font-semibold bg-gold/20 text-gold border border-gold/50 hover:bg-gold/30 transition-all">
            Accedi
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
