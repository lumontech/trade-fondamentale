// Unit tests per src/marketHours.js
// Eseguiti con: node --test tests/marketHours.test.js
// Zero dipendenze esterne (Node test runner nativo).
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { isMarketOpen, isMarketClosed } from '../src/marketHours.js'

// Helper: ts UTC in secondi
const tsUTC = (y, m, d, h = 0, min = 0) => Math.floor(Date.UTC(y, m - 1, d, h, min) / 1000)

// Date di riferimento (verificate con getUTCDay()):
//   2026-05-08 = Venerdi (5)
//   2026-05-09 = Sabato  (6)
//   2026-05-10 = Domenica(0)
//   2026-05-11 = Lunedi  (1)

describe('isMarketOpen — FOREX', () => {
  it('EURUSD sabato 12:00 UTC → CLOSED', () => {
    const r = isMarketOpen('EURUSD', tsUTC(2026, 5, 9, 12))
    assert.equal(r.open, false)
    assert.match(r.reason, /Saturday/)
  })

  it('EURUSD domenica 23:00 UTC → OPEN (apertura settimana >=22)', () => {
    const r = isMarketOpen('EURUSD', tsUTC(2026, 5, 10, 23))
    assert.equal(r.open, true)
  })

  it('EURUSD venerdi 21:00 UTC → OPEN (chiusura solo da 22)', () => {
    const r = isMarketOpen('EURUSD', tsUTC(2026, 5, 8, 21))
    assert.equal(r.open, true)
  })

  it('EURUSD venerdi 23:00 UTC → CLOSED (>=22 chiuso)', () => {
    const r = isMarketOpen('EURUSD', tsUTC(2026, 5, 8, 23))
    assert.equal(r.open, false)
    assert.match(r.reason, /Fri >=22/)
  })

  it('EURUSD lunedi 09:00 UTC → OPEN', () => {
    const r = isMarketOpen('EURUSD', tsUTC(2026, 5, 11, 9))
    assert.equal(r.open, true)
  })

  it('EURUSD domenica 21:59 UTC → CLOSED (<22 ancora chiuso)', () => {
    const r = isMarketOpen('EURUSD', tsUTC(2026, 5, 10, 21, 59))
    assert.equal(r.open, false)
    assert.match(r.reason, /Sun <22/)
  })
})

describe('isMarketOpen — XAU (oro segue forex hours)', () => {
  it('XAUUSD venerdi 21:00 UTC → OPEN', () => {
    const r = isMarketOpen('XAUUSD', tsUTC(2026, 5, 8, 21))
    assert.equal(r.open, true)
  })

  it('XAUUSD venerdi 23:00 UTC → CLOSED', () => {
    const r = isMarketOpen('XAUUSD', tsUTC(2026, 5, 8, 23))
    assert.equal(r.open, false)
  })

  it('XAUUSD sabato 12:00 UTC → CLOSED', () => {
    const r = isMarketOpen('XAUUSD', tsUTC(2026, 5, 9, 12))
    assert.equal(r.open, false)
    assert.match(r.reason, /Saturday/)
  })
})

describe('isMarketOpen — CRYPTO 24/7', () => {
  it('BTCUSD sabato → OPEN', () => {
    const r = isMarketOpen('BTCUSD', tsUTC(2026, 5, 9, 12))
    assert.equal(r.open, true)
  })

  it('BTCUSD domenica 03:00 UTC → OPEN', () => {
    const r = isMarketOpen('BTCUSD', tsUTC(2026, 5, 10, 3))
    assert.equal(r.open, true)
  })
})

describe('isMarketOpen — USOIL e DXY (Phase 1 fix)', () => {
  it('USOIL sabato 12:00 UTC → CLOSED', () => {
    const r = isMarketOpen('USOIL', tsUTC(2026, 5, 9, 12))
    assert.equal(r.open, false)
  })

  it('USOIL lunedi 14:00 UTC → OPEN', () => {
    const r = isMarketOpen('USOIL', tsUTC(2026, 5, 11, 14))
    assert.equal(r.open, true)
  })

  it('DXY sabato 12:00 UTC → CLOSED', () => {
    const r = isMarketOpen('DXY', tsUTC(2026, 5, 9, 12))
    assert.equal(r.open, false)
  })

  it('DXY venerdi 23:30 UTC → CLOSED (post 22:00)', () => {
    const r = isMarketOpen('DXY', tsUTC(2026, 5, 8, 23, 30))
    assert.equal(r.open, false)
  })
})

describe('isMarketOpen — INDICI USA', () => {
  it('US500 lunedi 14:00 UTC → OPEN (RTH)', () => {
    const r = isMarketOpen('US500', tsUTC(2026, 5, 11, 14))
    assert.equal(r.open, true)
  })

  it('US500 lunedi 13:15 UTC → CLOSED (pre-market)', () => {
    const r = isMarketOpen('US500', tsUTC(2026, 5, 11, 13, 15))
    assert.equal(r.open, false)
    assert.match(r.reason, /pre-market/)
  })

  it('US500 sabato → CLOSED', () => {
    const r = isMarketOpen('US500', tsUTC(2026, 5, 9, 14))
    assert.equal(r.open, false)
    assert.match(r.reason, /weekend/)
  })

  it('US500 lunedi 21:00 UTC → CLOSED (post-RTH)', () => {
    const r = isMarketOpen('US500', tsUTC(2026, 5, 11, 21))
    assert.equal(r.open, false)
  })
})

describe('isMarketOpen — Asset sconosciuto fail-open', () => {
  it('UNKNOWN_PAIR sabato → OPEN (fail-open per nuove strategie)', () => {
    const r = isMarketOpen('UNKNOWN_PAIR', tsUTC(2026, 5, 9, 12))
    assert.equal(r.open, true)
  })
})

describe('isMarketClosed — wrapper inverso', () => {
  it('EURUSD sabato → true', () => {
    assert.equal(isMarketClosed('EURUSD', tsUTC(2026, 5, 9, 12)), true)
  })
  it('BTCUSD sabato → false', () => {
    assert.equal(isMarketClosed('BTCUSD', tsUTC(2026, 5, 9, 12)), false)
  })
})
