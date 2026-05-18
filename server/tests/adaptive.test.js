// Unit tests per src/adaptive.js — Phase 4.2 fix.
//
// Focus:
//   - isAdaptiveEnabled() rispetta env ADAPTIVE_SLTP_ENABLED
//   - recomputeMultipliers() ritorna null se disabilitato (regola: DEFAULT OFF)
//   - recomputeMultipliers() ritorna null se trades < WINDOW (20) o non multiplo di 20
//   - applyMultiplierAdjustment() con clamping in [0.5..3.0] / [0.5..5.0]
//   - WR < 35% → slDelta=+0.2, tpDelta=-0.2
//   - WR > 55% → slDelta=-0.1, tpDelta=+0.3
//   - 35 <= WR <= 55 → null (no change)
//
// Eseguito con: node --test tests/adaptive.test.js

import { describe, it, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import {
  isAdaptiveEnabled,
  recomputeMultipliers,
  applyMultiplierAdjustment,
} from '../src/adaptive.js'

// ── Fake D1 DB minimale per recomputeMultipliers ──────────────────────
function makeFakeDb({ tradesCount = 0, wins = 0 } = {}) {
  // Genera N trade fittizi con ratio wins/tradesCount
  const trades = []
  for (let i = 0; i < tradesCount; i++) {
    trades.push({ raw_rr: i < wins ? +1.5 : -1, outcome: i < wins ? 'tp' : 'sl' })
  }
  return {
    prepare(sql) {
      const trimmed = sql.replace(/\s+/g, ' ').trim()
      return {
        _sql: trimmed,
        bind(...p) { this._p = p; return this },
        async first() {
          if (/SELECT COUNT\(\*\) AS n/.test(this._sql)) {
            return { n: trades.length }
          }
          return null
        },
        async all() {
          if (/SELECT raw_rr, outcome FROM sim_trades/.test(this._sql)) {
            const limit = this._p[1]
            return { results: trades.slice(0, limit) }
          }
          return { results: [] }
        },
        async run() { return { changes: 1 } },
      }
    },
  }
}

// ── isAdaptiveEnabled() ──────────────────────────────────────────────

describe('adaptive.isAdaptiveEnabled', () => {
  it('OFF di default (env undefined)', () => {
    delete process.env.ADAPTIVE_SLTP_ENABLED
    assert.equal(isAdaptiveEnabled(), false)
  })
  it('OFF se env != "true" (es. "1", "yes")', () => {
    process.env.ADAPTIVE_SLTP_ENABLED = '1'
    assert.equal(isAdaptiveEnabled(), false)
    process.env.ADAPTIVE_SLTP_ENABLED = 'yes'
    assert.equal(isAdaptiveEnabled(), false)
  })
  it('ON solo se env === "true" (string esatta)', () => {
    process.env.ADAPTIVE_SLTP_ENABLED = 'true'
    assert.equal(isAdaptiveEnabled(), true)
  })
  it('OFF se env vuota o false', () => {
    process.env.ADAPTIVE_SLTP_ENABLED = 'false'
    assert.equal(isAdaptiveEnabled(), false)
    process.env.ADAPTIVE_SLTP_ENABLED = ''
    assert.equal(isAdaptiveEnabled(), false)
  })
})

// ── recomputeMultipliers() ───────────────────────────────────────────

describe('adaptive.recomputeMultipliers — early returns', () => {
  it('ritorna null se ADAPTIVE_SLTP_ENABLED non e true', async () => {
    process.env.ADAPTIVE_SLTP_ENABLED = 'false'
    const db = makeFakeDb({ tradesCount: 100, wins: 20 })
    const r = await recomputeMultipliers(db, 'acc_x')
    assert.equal(r, null)
  })

  it('ritorna null se trades < WINDOW (20)', async () => {
    process.env.ADAPTIVE_SLTP_ENABLED = 'true'
    const db = makeFakeDb({ tradesCount: 19, wins: 5 })
    const r = await recomputeMultipliers(db, 'acc_x')
    assert.equal(r, null)
  })

  it('ritorna null se trades NON multiplo di 20 (es. 21)', async () => {
    process.env.ADAPTIVE_SLTP_ENABLED = 'true'
    const db = makeFakeDb({ tradesCount: 21, wins: 5 })
    const r = await recomputeMultipliers(db, 'acc_x')
    assert.equal(r, null)
  })

  it('ritorna null su WR mid-range (40%)', async () => {
    process.env.ADAPTIVE_SLTP_ENABLED = 'true'
    // 8 wins su 20 = 40% (tra 35 e 55) → null
    const db = makeFakeDb({ tradesCount: 20, wins: 8 })
    const r = await recomputeMultipliers(db, 'acc_x')
    assert.equal(r, null)
  })
})

describe('adaptive.recomputeMultipliers — adjustment direction', () => {
  it('WR < 35% → slDelta=+0.2, tpDelta=-0.2 (allarga SL, stringi TP)', async () => {
    process.env.ADAPTIVE_SLTP_ENABLED = 'true'
    // 6/20 = 30% (sotto 35%)
    const db = makeFakeDb({ tradesCount: 20, wins: 6 })
    const r = await recomputeMultipliers(db, 'acc_x')
    assert.ok(r, 'adjustment ritornato')
    assert.equal(r.slDelta, +0.2)
    assert.equal(r.tpDelta, -0.2)
    assert.equal(r.sampleSize, 20)
    assert.ok(r.winRate < 0.35)
  })

  it('WR > 55% → slDelta=-0.1, tpDelta=+0.3 (proteggi profitti)', async () => {
    process.env.ADAPTIVE_SLTP_ENABLED = 'true'
    // 14/20 = 70% (sopra 55%)
    const db = makeFakeDb({ tradesCount: 20, wins: 14 })
    const r = await recomputeMultipliers(db, 'acc_x')
    assert.ok(r, 'adjustment ritornato')
    assert.equal(r.slDelta, -0.1)
    assert.equal(r.tpDelta, +0.3)
    assert.ok(r.winRate > 0.55)
  })
})

// ── applyMultiplierAdjustment() ───────────────────────────────────────

describe('adaptive.applyMultiplierAdjustment — clamping', () => {
  it('null adj → return false, nessun cambio', () => {
    const acc = { sl_mul: 1.5, tp_mul: 3.0 }
    assert.equal(applyMultiplierAdjustment(acc, null), false)
    assert.equal(acc.sl_mul, 1.5)
    assert.equal(acc.tp_mul, 3.0)
  })

  it('clamp upper bound: sl_mul max=3.0, tp_mul max=5.0', () => {
    const acc = { sl_mul: 2.9, tp_mul: 4.9 }
    const r = applyMultiplierAdjustment(acc, { slDelta: 5.0, tpDelta: 2.0 })
    assert.equal(r, true)
    assert.equal(acc.sl_mul, 3.0, 'sl_mul clampato a SL_MAX=3.0')
    assert.equal(acc.tp_mul, 5.0, 'tp_mul clampato a TP_MAX=5.0')
  })

  it('clamp lower bound: sl_mul min=0.5, tp_mul min=0.5', () => {
    const acc = { sl_mul: 0.6, tp_mul: 0.7 }
    const r = applyMultiplierAdjustment(acc, { slDelta: -10.0, tpDelta: -10.0 })
    assert.equal(r, true)
    assert.equal(acc.sl_mul, 0.5)
    assert.equal(acc.tp_mul, 0.5)
  })

  it('delta normale aggiorna sl/tp_mul', () => {
    const acc = { sl_mul: 1.5, tp_mul: 3.0 }
    const r = applyMultiplierAdjustment(acc, { slDelta: +0.2, tpDelta: -0.2 })
    assert.equal(r, true)
    assert.ok(Math.abs(acc.sl_mul - 1.7) < 1e-9)
    assert.ok(Math.abs(acc.tp_mul - 2.8) < 1e-9)
  })

  it('ritorna false se il clamp annulla il delta (no-op effettivo)', () => {
    // Account gia al massimo, delta che spinge ulteriormente sopra → clamp = no change
    const acc = { sl_mul: 3.0, tp_mul: 5.0 }
    const r = applyMultiplierAdjustment(acc, { slDelta: +0.5, tpDelta: +0.5 })
    assert.equal(r, false, 'clamp annulla delta → return false')
    assert.equal(acc.sl_mul, 3.0)
    assert.equal(acc.tp_mul, 5.0)
  })
})
