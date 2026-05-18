// Unit tests per src/strategies.js — Phase 4.1 fix.
//
// Focus:
//   - findStrategy('ema921') ritorna null (disabled flag)
//   - findStrategy() ritorna oggetto valido per strategie attive (es. macdTrend, donchian)
//   - STRATEGIES include ema921 con enabled:false (per audit / future re-enable)
//
// Eseguito con: node --test tests/strategies.test.js

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { STRATEGIES, findStrategy } from '../src/strategies.js'

describe('strategies — Phase 4.1 disable EMA 9/21', () => {
  it('STRATEGIES include ema921 con enabled:false (audit trail)', () => {
    const ema = STRATEGIES.find(s => s.id === 'ema921')
    assert.ok(ema, 'ema921 ancora presente nel registry')
    assert.equal(ema.enabled, false, 'enabled flag = false')
  })

  it('findStrategy("ema921") ritorna null (filtro enabled)', () => {
    const r = findStrategy('ema921')
    assert.equal(r, null, 'findStrategy filtra strategie disabilitate')
  })

  it('findStrategy("nonExistent") ritorna null', () => {
    assert.equal(findStrategy('nonExistent'), null)
  })

  it('findStrategy("macdTrend") ritorna oggetto strategia valido', () => {
    const r = findStrategy('macdTrend')
    assert.ok(r, 'strategia attiva trovata')
    assert.equal(r.id, 'macdTrend')
    assert.equal(r.category, 'swing')
    assert.equal(typeof r.fn, 'function')
  })

  it('findStrategy("donchian") attiva', () => {
    const r = findStrategy('donchian')
    assert.ok(r)
    assert.equal(r.id, 'donchian')
  })

  it('strategie scalp ancora attive (vwap, bbReversal, liqSweep, threeBarRev, etc.)', () => {
    for (const id of ['vwap', 'bbReversal', 'liqSweep', 'threeBarRev', 'failedBk', 'mssChoCHScalp', 'pivotReversal']) {
      const r = findStrategy(id)
      assert.ok(r, `${id} dovrebbe essere attiva`)
      assert.equal(r.category, 'scalp')
    }
  })

  it('STRATEGIES.filter(s => s.enabled !== false) — counts (per audit)', () => {
    const enabled = STRATEGIES.filter(s => s.enabled !== false)
    const disabled = STRATEGIES.filter(s => s.enabled === false)
    assert.equal(disabled.length, 1, 'esattamente 1 strategia disabilitata (ema921)')
    assert.equal(disabled[0].id, 'ema921')
    assert.ok(enabled.length >= 18, `${enabled.length} strategie attive (>= 18 attese)`)
  })
})
