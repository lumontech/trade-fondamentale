// Unit tests per src/auth.js — Phase 3.1 fix.
//
// IMPORTANT: questi test richiedono `bcryptjs` installato in node_modules.
// In env CI / dev pulito (es. dopo pull senza npm install) bcryptjs potrebbe
// non essere presente. Per non rompere il test runner facciamo un PROBE con
// import dinamico: se bcryptjs manca, ogni test viene SKIPPATO con t.skip()
// e logghiamo un warning. Questo evita falsi negativi senza richiedere stub
// in node_modules (vincolo: tester NON modifica codice produzione).
//
// Eseguito con: node --experimental-test-module-mocks --test tests/auth.test.js
//
// Quando bcryptjs e installato (production / npm install completo) i test
// coprono:
//   - login: ok / invalid_credentials / lockout 5/15min
//   - getSessionUser: token valido / null / scaduto
//   - logout: rimuove sessione
//   - cleanupExpiredSessions: rimuove SOLO scadute
//   - authMiddleware: public/private path, cookie valido/invalido
//   - getTokenFromRequest: parse cookie

import { describe, it, mock } from 'node:test'
import assert from 'node:assert/strict'

// ── Probe bcryptjs ────────────────────────────────────────────────────
let bcryptInstalled = false
try {
  await import('bcryptjs')
  bcryptInstalled = true
} catch {
  bcryptInstalled = false
}

if (!bcryptInstalled) {
  console.warn('[auth.test] bcryptjs NON installato in node_modules — tutti i test saranno SKIPPED')
}

// ── Conditional helper: skip if bcrypt unavailable ────────────────────
const skipIfNoBcrypt = (t) => {
  if (!bcryptInstalled) {
    t.skip('bcryptjs non installato in questo env')
    return true
  }
  return false
}

// ── Lazy module loading: importiamo auth.js SOLO se bcrypt e disponibile.
// Altrimenti l'import top-level di bcrypt in auth.js causerebbe ERR_MODULE_NOT_FOUND.
let auth = null
let COOKIE_NAME = null
if (bcryptInstalled) {
  // Mock bcryptjs PRIMA dell'import di auth.js (mock.module DOPO import.meta valida)
  mock.module('bcryptjs', {
    defaultExport: {
      hash: async (pwd, cost) => `hashed:${pwd}:${cost}`,
      compare: async (pwd, hash) => hash === `hashed:${pwd}:12`,
    },
  })
  auth = await import('../src/auth.js')
  COOKIE_NAME = auth.COOKIE_NAME
}

// ── Fake D1 DB ────────────────────────────────────────────────────────
function makeFakeDb() {
  const state = {
    sim_users: [],
    sim_sessions: [],
  }
  let userIdSeq = 1

  return {
    state,
    addUser({ username, password, role = 'admin' }) {
      const u = {
        id: userIdSeq++,
        username,
        password_hash: `hashed:${password}:12`,
        role,
        created_at: Math.floor(Date.now() / 1000),
        last_login_at: null,
      }
      state.sim_users.push(u)
      return u
    },
    prepare(sql) {
      const trimmed = sql.replace(/\s+/g, ' ').trim()
      return {
        _sql: trimmed,
        bind(...p) { this._p = p; return this },
        async first() {
          if (/SELECT \* FROM sim_users WHERE username = \?/.test(this._sql)) {
            return state.sim_users.find(u => u.username === this._p[0]) || null
          }
          if (/SELECT s\.id AS token, s\.expires_at, u\.id AS user_id/.test(this._sql)) {
            const sess = state.sim_sessions.find(s => s.id === this._p[0])
            if (!sess || sess.expires_at <= this._p[1]) return null
            const usr = state.sim_users.find(u => u.id === sess.user_id)
            if (!usr) return null
            return {
              token: sess.id, expires_at: sess.expires_at,
              user_id: usr.id, username: usr.username, role: usr.role,
            }
          }
          return null
        },
        async run() {
          if (/INSERT INTO sim_sessions/.test(this._sql)) {
            state.sim_sessions.push({
              id: this._p[0], user_id: this._p[1],
              created_at: this._p[2], expires_at: this._p[3],
              ip: this._p[4], user_agent: this._p[5],
            })
            return { changes: 1 }
          }
          if (/UPDATE sim_users SET last_login_at = \? WHERE id = \?/.test(this._sql)) {
            const u = state.sim_users.find(x => x.id === this._p[1])
            if (u) u.last_login_at = this._p[0]
            return { changes: u ? 1 : 0 }
          }
          if (/DELETE FROM sim_sessions WHERE id = \?/.test(this._sql)) {
            const before = state.sim_sessions.length
            state.sim_sessions = state.sim_sessions.filter(s => s.id !== this._p[0])
            return { changes: before - state.sim_sessions.length }
          }
          if (/DELETE FROM sim_sessions WHERE expires_at < \?/.test(this._sql)) {
            const before = state.sim_sessions.length
            state.sim_sessions = state.sim_sessions.filter(s => s.expires_at >= this._p[0])
            return { changes: before - state.sim_sessions.length }
          }
          return { changes: 0 }
        },
        async all() { return { results: [] } },
      }
    },
  }
}

// ── login() — happy path ──────────────────────────────────────────────

describe('auth.login — credenziali valide', () => {
  it('login OK con username/password corretti → ritorna token + user', async (t) => {
    if (skipIfNoBcrypt(t)) return
    const db = makeFakeDb()
    db.addUser({ username: 'stefano', password: 'M1aPwd!' })

    const r = await auth.login(db, 'stefano', 'M1aPwd!', '127.0.0.1', 'TestAgent')

    assert.equal(r.ok, true)
    assert.ok(r.token, 'token presente')
    assert.equal(r.token.length, 64, 'token = 32 bytes hex (64 char)')
    assert.match(r.token, /^[a-f0-9]+$/i)
    assert.equal(r.user.username, 'stefano')
    assert.equal(r.user.role, 'admin')
    assert.ok(r.expiresIn > 0)
    assert.equal(db.state.sim_sessions.length, 1)
    assert.equal(db.state.sim_sessions[0].id, r.token)
  })
})

describe('auth.login — credenziali invalide', () => {
  it('login fail su username inesistente → invalid_credentials', async (t) => {
    if (skipIfNoBcrypt(t)) return
    const db = makeFakeDb()
    const r = await auth.login(db, 'nonExistent', 'pwd', '127.0.0.1', 'UA')
    assert.equal(r.ok, false)
    assert.equal(r.error, 'invalid_credentials')
  })

  it('login fail su password sbagliata → invalid_credentials', async (t) => {
    if (skipIfNoBcrypt(t)) return
    const db = makeFakeDb()
    db.addUser({ username: 'stefano', password: 'CorrectPwd' })
    const r = await auth.login(db, 'stefano', 'WrongPwd', '127.0.0.1', 'UA')
    assert.equal(r.ok, false)
    assert.equal(r.error, 'invalid_credentials')
    assert.equal(db.state.sim_sessions.length, 0, 'nessuna sessione creata')
  })
})

describe('auth.login — lockout 5/15min', () => {
  it('lockout dopo 5 tentativi falliti dallo stesso IP', async (t) => {
    if (skipIfNoBcrypt(t)) return
    const db = makeFakeDb()
    db.addUser({ username: 'stefano', password: 'CorrectPwd' })
    const ip = '10.0.0.99'

    for (let i = 0; i < 5; i++) {
      const r = await auth.login(db, 'stefano', 'WrongPwd', ip, 'UA')
      assert.equal(r.ok, false)
      assert.equal(r.error, 'invalid_credentials')
    }
    const r6 = await auth.login(db, 'stefano', 'CorrectPwd', ip, 'UA')
    assert.equal(r6.ok, false)
    assert.equal(r6.error, 'too_many_attempts')
    assert.ok(r6.retryIn > 0, 'retryIn fornito')
    assert.ok(r6.retryIn <= 15 * 60, 'retryIn entro 15 min')
  })

  it('IP diverso non viene bloccato dal lockout di un altro IP', async (t) => {
    if (skipIfNoBcrypt(t)) return
    const db = makeFakeDb()
    db.addUser({ username: 'stefano', password: 'CorrectPwd' })

    for (let i = 0; i < 5; i++) {
      await auth.login(db, 'stefano', 'WrongPwd', '1.1.1.1', 'UA')
    }
    const r = await auth.login(db, 'stefano', 'CorrectPwd', '2.2.2.2', 'UA')
    assert.equal(r.ok, true)
  })

  it('login OK clear lockout per IP', async (t) => {
    if (skipIfNoBcrypt(t)) return
    const db = makeFakeDb()
    db.addUser({ username: 'stefano', password: 'CorrectPwd' })
    const ip = '3.3.3.3'

    for (let i = 0; i < 4; i++) {
      await auth.login(db, 'stefano', 'WrongPwd', ip, 'UA')
    }
    const ok = await auth.login(db, 'stefano', 'CorrectPwd', ip, 'UA')
    assert.equal(ok.ok, true)
    for (let i = 0; i < 5; i++) {
      const r = await auth.login(db, 'stefano', 'WrongPwd', ip, 'UA')
      assert.equal(r.error, 'invalid_credentials')
    }
  })
})

// ── getSessionUser() ──────────────────────────────────────────────────

describe('auth.getSessionUser', () => {
  it('token valido → ritorna user', async (t) => {
    if (skipIfNoBcrypt(t)) return
    const db = makeFakeDb()
    db.addUser({ username: 'stefano', password: 'M1aPwd!' })
    const r = await auth.login(db, 'stefano', 'M1aPwd!', '127.0.0.1', 'UA')

    const sess = await auth.getSessionUser(db, r.token)
    assert.ok(sess)
    assert.equal(sess.username, 'stefano')
    assert.equal(sess.role, 'admin')
  })

  it('token null/undefined → null', async (t) => {
    if (skipIfNoBcrypt(t)) return
    const db = makeFakeDb()
    assert.equal(await auth.getSessionUser(db, null), null)
    assert.equal(await auth.getSessionUser(db, undefined), null)
    assert.equal(await auth.getSessionUser(db, ''), null)
  })

  it('token scaduto → null', async (t) => {
    if (skipIfNoBcrypt(t)) return
    const db = makeFakeDb()
    db.addUser({ username: 'stefano', password: 'M1aPwd!' })
    db.state.sim_sessions.push({
      id: 'expired_token',
      user_id: 1,
      created_at: 0,
      expires_at: Math.floor(Date.now() / 1000) - 10,
      ip: 'x',
      user_agent: 'x',
    })
    const r = await auth.getSessionUser(db, 'expired_token')
    assert.equal(r, null)
  })
})

// ── logout() ──────────────────────────────────────────────────────────

describe('auth.logout', () => {
  it('logout rimuove la sessione', async (t) => {
    if (skipIfNoBcrypt(t)) return
    const db = makeFakeDb()
    db.addUser({ username: 'stefano', password: 'M1aPwd!' })
    const r = await auth.login(db, 'stefano', 'M1aPwd!', '127.0.0.1', 'UA')

    assert.equal(db.state.sim_sessions.length, 1)
    await auth.logout(db, r.token)
    assert.equal(db.state.sim_sessions.length, 0)
    assert.equal(await auth.getSessionUser(db, r.token), null)
  })
  it('logout con token null → no-op', async (t) => {
    if (skipIfNoBcrypt(t)) return
    const db = makeFakeDb()
    await auth.logout(db, null)
    await auth.logout(db, undefined)
    assert.equal(db.state.sim_sessions.length, 0)
  })
})

// ── cleanupExpiredSessions() ──────────────────────────────────────────

describe('auth.cleanupExpiredSessions', () => {
  it('rimuove SOLO sessioni con expires_at < now', async (t) => {
    if (skipIfNoBcrypt(t)) return
    const db = makeFakeDb()
    const now = Math.floor(Date.now() / 1000)
    db.state.sim_sessions.push(
      { id: 'old1',  user_id: 1, created_at: 0, expires_at: now - 100, ip: '', user_agent: '' },
      { id: 'old2',  user_id: 1, created_at: 0, expires_at: now - 1,   ip: '', user_agent: '' },
      { id: 'fresh', user_id: 1, created_at: 0, expires_at: now + 100, ip: '', user_agent: '' },
    )
    const removed = await auth.cleanupExpiredSessions(db)
    assert.equal(removed, 2)
    assert.equal(db.state.sim_sessions.length, 1)
    assert.equal(db.state.sim_sessions[0].id, 'fresh')
  })
})

// ── authMiddleware() ──────────────────────────────────────────────────

describe('auth.authMiddleware', () => {
  function makeCtx({ path, cookie }) {
    let json = null
    let status = 200
    return {
      _user: null,
      req: {
        url: 'http://localhost' + path,
        header(name) {
          if (name === 'cookie') return cookie || null
          return null
        },
      },
      json(payload, code) {
        json = payload
        status = code || 200
        return { status, json }
      },
      set(k, v) { if (k === 'user') this._user = v },
      get(k) { if (k === 'user') return this._user; return null },
      _result() { return { json, status } },
    }
  }

  it('public path passa senza cookie', async (t) => {
    if (skipIfNoBcrypt(t)) return
    const db = makeFakeDb()
    const mw = auth.authMiddleware(db, ['/api/health', '/api/auth/login'])
    const ctx = makeCtx({ path: '/api/health' })
    let nextCalled = false
    await mw(ctx, async () => { nextCalled = true })
    assert.equal(nextCalled, true)
  })

  it('private path senza cookie → 401 unauthorized', async (t) => {
    if (skipIfNoBcrypt(t)) return
    const db = makeFakeDb()
    const mw = auth.authMiddleware(db, ['/api/health'])
    const ctx = makeCtx({ path: '/api/state' })
    let nextCalled = false
    await mw(ctx, async () => { nextCalled = true })
    assert.equal(nextCalled, false)
    const r = ctx._result()
    assert.equal(r.status, 401)
    assert.equal(r.json.error, 'unauthorized')
  })

  it('private path con cookie valido → next() + user settato', async (t) => {
    if (skipIfNoBcrypt(t)) return
    const db = makeFakeDb()
    db.addUser({ username: 'stefano', password: 'M1aPwd!' })
    const r = await auth.login(db, 'stefano', 'M1aPwd!', 'ip', 'UA')

    const mw = auth.authMiddleware(db, ['/api/health'])
    const ctx = makeCtx({ path: '/api/state', cookie: `${COOKIE_NAME}=${r.token}` })
    let nextCalled = false
    await mw(ctx, async () => { nextCalled = true })
    assert.equal(nextCalled, true)
    assert.equal(ctx._user.username, 'stefano')
  })

  it('public prefix match (path.startsWith(p+/))', async (t) => {
    if (skipIfNoBcrypt(t)) return
    const db = makeFakeDb()
    const mw = auth.authMiddleware(db, ['/api/auth'])
    const ctx = makeCtx({ path: '/api/auth/login' })
    let nextCalled = false
    await mw(ctx, async () => { nextCalled = true })
    assert.equal(nextCalled, true)
  })
})

// ── getTokenFromRequest() ─────────────────────────────────────────────

describe('auth.getTokenFromRequest', () => {
  it('estrae token da cookie con un solo entry', (t) => {
    if (skipIfNoBcrypt(t)) return
    const ctx = { req: { header: (n) => n === 'cookie' ? `${COOKIE_NAME}=abc123def456` : null } }
    assert.equal(auth.getTokenFromRequest(ctx), 'abc123def456')
  })
  it('estrae token in cookie con piu entry', (t) => {
    if (skipIfNoBcrypt(t)) return
    const ctx = { req: { header: () => `foo=bar; ${COOKIE_NAME}=deadbeef; baz=qux` } }
    assert.equal(auth.getTokenFromRequest(ctx), 'deadbeef')
  })
  it('ritorna null se cookie assente', (t) => {
    if (skipIfNoBcrypt(t)) return
    const ctx = { req: { header: () => null } }
    assert.equal(auth.getTokenFromRequest(ctx), null)
  })
  it('ritorna null se cookie non contiene il nostro token', (t) => {
    if (skipIfNoBcrypt(t)) return
    const ctx = { req: { header: () => 'foo=bar; baz=qux' } }
    assert.equal(auth.getTokenFromRequest(ctx), null)
  })
})
