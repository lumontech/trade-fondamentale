// Auth helpers — sessione cookie HttpOnly, bcryptjs hash, lockout in-memory.
// Single-user (Stefano) ma robust: random token 256-bit, lockout 5/15min, TTL 7gg.
//
// Schema dipendente dalla migration 0004 (sim_users, sim_sessions).
// Usato da server/src/index.js (middleware + endpoint /api/auth/*) e da
// server/scripts/createUser.js (bootstrap CLI).

import bcrypt from 'bcryptjs'
import { randomBytes } from 'node:crypto'

const SESSION_TTL_SEC = 7 * 24 * 60 * 60   // 7 giorni
const COOKIE_NAME = 'itp_session'
const BCRYPT_COST = 12

// ── Lockout protection — in-memory (single-process VPS) ─────────────
// Su VPS Contabo single-instance basta una Map. Se in futuro si scala
// orizzontalmente -> spostare in DB (sim_login_attempts).
const loginAttempts = new Map()  // ip -> { count, resetAt }
const MAX_ATTEMPTS = 5
const LOCKOUT_WINDOW_MS = 15 * 60 * 1000   // 15 minuti

function checkLockout(ip) {
  const a = loginAttempts.get(ip)
  if (!a) return { locked: false }
  if (Date.now() > a.resetAt) {
    loginAttempts.delete(ip)
    return { locked: false }
  }
  return {
    locked: a.count >= MAX_ATTEMPTS,
    retryIn: Math.ceil((a.resetAt - Date.now()) / 1000),
  }
}

function recordFailedAttempt(ip) {
  const a = loginAttempts.get(ip) || { count: 0, resetAt: Date.now() + LOCKOUT_WINDOW_MS }
  a.count++
  loginAttempts.set(ip, a)
}

function clearLockout(ip) {
  loginAttempts.delete(ip)
}

// ── Login ────────────────────────────────────────────────────────────
// Restituisce { ok, token, expiresIn, user } o { ok:false, error, [retryIn] }.
// Errori possibili: 'too_many_attempts', 'invalid_credentials'.
export async function login(db, username, password, ip, userAgent) {
  const lock = checkLockout(ip)
  if (lock.locked) {
    return { ok: false, error: 'too_many_attempts', retryIn: lock.retryIn }
  }

  const u = await db.prepare('SELECT * FROM sim_users WHERE username = ?').bind(username).first()
  if (!u) {
    recordFailedAttempt(ip)
    return { ok: false, error: 'invalid_credentials' }
  }

  const ok = await bcrypt.compare(password, u.password_hash)
  if (!ok) {
    recordFailedAttempt(ip)
    return { ok: false, error: 'invalid_credentials' }
  }

  clearLockout(ip)
  const token = randomBytes(32).toString('hex')   // 64-char hex, 256-bit entropy
  const now = Math.floor(Date.now() / 1000)
  const expiresAt = now + SESSION_TTL_SEC
  await db.prepare(
    'INSERT INTO sim_sessions (id, user_id, created_at, expires_at, ip, user_agent) VALUES (?, ?, ?, ?, ?, ?)'
  ).bind(token, u.id, now, expiresAt, ip || null, (userAgent || '').slice(0, 200)).run()
  await db.prepare('UPDATE sim_users SET last_login_at = ? WHERE id = ?').bind(now, u.id).run()

  return {
    ok: true,
    token,
    expiresIn: SESSION_TTL_SEC,
    user: { id: u.id, username: u.username, role: u.role },
  }
}

// ── Logout ───────────────────────────────────────────────────────────
export async function logout(db, token) {
  if (!token) return
  await db.prepare('DELETE FROM sim_sessions WHERE id = ?').bind(token).run()
}

// ── Session lookup ───────────────────────────────────────────────────
// Restituisce { token, expires_at, user_id, username, role } o null.
export async function getSessionUser(db, token) {
  if (!token) return null
  const now = Math.floor(Date.now() / 1000)
  const sess = await db.prepare(
    `SELECT s.id AS token, s.expires_at, u.id AS user_id, u.username, u.role
     FROM sim_sessions s JOIN sim_users u ON u.id = s.user_id
     WHERE s.id = ? AND s.expires_at > ?`
  ).bind(token, now).first()
  return sess || null
}

// ── Cookie parsing helper ────────────────────────────────────────────
function extractToken(cookieHeader) {
  if (!cookieHeader) return null
  const re = new RegExp(`(?:^|;\\s*)${COOKIE_NAME}=([a-f0-9]+)`)
  const m = cookieHeader.match(re)
  return m ? m[1] : null
}

// ── Hono middleware factory ──────────────────────────────────────────
// publicPaths: array di path che NON richiedono autenticazione.
// Match esatto OR prefix (path === p || path.startsWith(p + '/')).
export function authMiddleware(db, publicPaths = []) {
  return async (c, next) => {
    const path = new URL(c.req.url).pathname
    if (publicPaths.some(p => path === p || path.startsWith(p + '/'))) {
      return next()
    }
    const token = extractToken(c.req.header('cookie'))
    const user = await getSessionUser(db, token)
    if (!user) return c.json({ error: 'unauthorized' }, 401)
    c.set('user', user)
    return next()
  }
}

// ── Cleanup sessioni scadute (chiamato da cron orario) ───────────────
export async function cleanupExpiredSessions(db) {
  const now = Math.floor(Date.now() / 1000)
  const r = await db.prepare('DELETE FROM sim_sessions WHERE expires_at < ?').bind(now).run()
  return r?.changes ?? 0
}

// ── Helper esposto al codice route per estrarre token dal request ────
export function getTokenFromRequest(c) {
  return extractToken(c.req.header('cookie'))
}

export { COOKIE_NAME, SESSION_TTL_SEC, BCRYPT_COST }
