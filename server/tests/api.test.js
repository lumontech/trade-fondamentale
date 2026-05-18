// Smoke tests per endpoint API — Phase 2.4, 2.1c, 3.2, 3.3.
//
// Strategia: testiamo le PARTI di logica isolabili senza bootstrap completo
// del server (che richiede better-sqlite3 + bcryptjs in node_modules).
//
// Cosa testiamo:
//   - getTdQuota() — Phase 2.4 — visibility quota TwelveData
//     (record + reset day + remaining)
//   - rate-limit logic isolata (Phase 3.3) — sliding window in-memory
//   - CORS allow-list parsing (Phase 3.2) — strict mode in production
//
// Cosa NON testiamo (richiede DB / bcrypt / Hono):
//   - /api/health/profiles — query SQL su sim_config + sim_accounts
//   - /api/health/twelvedata endpoint (testato getTdQuota direttamente)
//   - /api/auth/* — vedi auth.test.js
//   - /api/tick rate-limited end-to-end — testiamo logica isolata
//
// Eseguito con: node --test tests/api.test.js

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { getTdQuota, recordTdCall } from '../src/data.js'

// ── Phase 2.4 — TwelveData quota tracking ─────────────────────────────

describe('data.getTdQuota — Phase 2.4 quota visibility', () => {
  it('struttura risposta: used, limit, remaining, resetDay', () => {
    const q = getTdQuota()
    assert.ok(Object.prototype.hasOwnProperty.call(q, 'used'))
    assert.ok(Object.prototype.hasOwnProperty.call(q, 'limit'))
    assert.ok(Object.prototype.hasOwnProperty.call(q, 'remaining'))
    assert.ok(Object.prototype.hasOwnProperty.call(q, 'resetDay'))
    assert.equal(q.limit, 1600, 'limit = 2 keys × 800 credits/day')
    assert.equal(typeof q.used, 'number')
    assert.equal(typeof q.remaining, 'number')
    assert.equal(typeof q.resetDay, 'string')
  })

  it('recordTdCall incrementa "used"', () => {
    const before = getTdQuota().used
    recordTdCall(3)
    const after = getTdQuota().used
    assert.equal(after - before, 3, 'used incrementato di 3')
  })

  it('remaining = limit - used (mai negativo)', () => {
    const q = getTdQuota()
    assert.equal(q.remaining, Math.max(0, q.limit - q.used))
  })
})

// ── Phase 3.3 — Rate limit logic (sliding window in-memory) ───────────
// Riimplemento la stessa logica di index.js (privato, non esportato) per
// validarla isolatamente.

function makeRateLimiter(max, windowMs) {
  const buckets = new Map()
  return function check(ip, nowFn = () => Date.now()) {
    const now = nowFn()
    let b = buckets.get(ip)
    if (!b || now > b.reset) {
      b = { count: 0, reset: now + windowMs }
      buckets.set(ip, b)
    }
    b.count++
    return b.count <= max
  }
}

describe('rate-limit — Phase 3.3 (10 req/min per IP)', () => {
  it('IP entro 10 req → tutte OK', () => {
    const rl = makeRateLimiter(10, 60_000)
    for (let i = 0; i < 10; i++) {
      assert.equal(rl('1.1.1.1'), true, `req ${i+1} dovrebbe passare`)
    }
  })

  it('IP supera 10 req in 60s → rate limited', () => {
    const rl = makeRateLimiter(10, 60_000)
    for (let i = 0; i < 10; i++) rl('1.1.1.1')
    const r11 = rl('1.1.1.1')
    assert.equal(r11, false, '11° req rate-limited')
  })

  it('IP diverso ha bucket separato', () => {
    const rl = makeRateLimiter(10, 60_000)
    for (let i = 0; i < 10; i++) rl('1.1.1.1')
    assert.equal(rl('1.1.1.1'), false)
    assert.equal(rl('2.2.2.2'), true, 'IP diverso non condivide bucket')
  })

  it('reset bucket dopo windowMs', () => {
    const rl = makeRateLimiter(2, 1000)
    let now = 1000
    rl('x', () => now)  // 1
    rl('x', () => now)  // 2
    assert.equal(rl('x', () => now), false, '3° rate-limited')
    now = 3000  // oltre window
    assert.equal(rl('x', () => now), true, 'reset dopo windowMs')
  })
})

// ── Phase 3.2 — CORS allow-list parsing ──────────────────────────────

function parseAllowedOrigins(envValue, isProduction) {
  const defaultAllowed = isProduction ? '' : 'http://localhost:5173'
  return (envValue || defaultAllowed).split(',').map(s => s.trim()).filter(Boolean)
}

describe('CORS allow-list — Phase 3.2 strict in production', () => {
  it('production senza ALLOWED_ORIGINS → array vuoto (NO fallback localhost)', () => {
    const origins = parseAllowedOrigins(undefined, true)
    assert.deepEqual(origins, [])
  })

  it('production con ALLOWED_ORIGINS valido → solo quelli specificati', () => {
    const origins = parseAllowedOrigins('https://impact.app,https://staging.impact.app', true)
    assert.deepEqual(origins, ['https://impact.app', 'https://staging.impact.app'])
  })

  it('dev senza ALLOWED_ORIGINS → fallback http://localhost:5173', () => {
    const origins = parseAllowedOrigins(undefined, false)
    assert.deepEqual(origins, ['http://localhost:5173'])
  })

  it('entry vuote (",,") filtrate', () => {
    const origins = parseAllowedOrigins('https://a.com,,https://b.com,', true)
    assert.deepEqual(origins, ['https://a.com', 'https://b.com'])
  })

  it('whitespace trimmed', () => {
    const origins = parseAllowedOrigins(' https://a.com , https://b.com ', true)
    assert.deepEqual(origins, ['https://a.com', 'https://b.com'])
  })

  it('CORS callback: origin in lista → consentito (returns origin), altrimenti null', () => {
    const ALLOWED = parseAllowedOrigins('https://impact.app', true)
    const corsCheck = (origin) => ALLOWED.includes(origin) ? origin : null
    assert.equal(corsCheck('https://impact.app'), 'https://impact.app')
    assert.equal(corsCheck('https://evil.com'), null)
    assert.equal(corsCheck(''), null, 'origin vuoto rifiutato')
  })
})
