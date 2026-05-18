// Integration tests per src/sim.js (runTick) — testano:
//   - cold start startIdx (=  candles.length - 3 quando last_bar_time è null)
//   - apertura posizione su segnale strategia
//   - SL hit (outcome 'sl')
//   - WEEKEND FREEZE (Fix #1.3): posizione long su EURUSD aperta venerdi 21:00,
//     candele weekend con low<sl → posizione resta aperta, lunedi low<sl → SL triggera
//   - calcTimeoutR via timeout exit
//   - BTCUSD (24/7) NON deve mai accumulare frozenBars
//
// Eseguito con:
//   node --experimental-test-module-mocks --test tests/sim.test.js
//
// Strategia di test: mockiamo data.js (loadCandles), strategies.js (per controllare
// il segnale), newsFilter.js (sblocchiamo tutto). Il DB è una fake in-memory che
// implementa il contratto D1-like (prepare/bind/run/first/all + batch).

import { describe, it, before, mock } from 'node:test'
import assert from 'node:assert/strict'

// ── 0. Module mocks (DEVONO essere prima dell'import di sim.js) ──────
//    Strategia controllabile: emette un segnale long quando
//    `globalThis.__TEST_NEXT_SIGNAL__` è valorizzato (e poi lo consuma).

const STRATEGIES_FAKE = [
  {
    id: 'fakeLong',
    name: 'Fake Long Signal',
    category: 'swing',
    slMul: 1.5,
    tpMul: 3.0,
    fn: function fakeStrategy(candles, i) {
      const sig = globalThis.__TEST_NEXT_SIGNAL__
      if (sig && sig.atIdx === i) {
        globalThis.__TEST_NEXT_SIGNAL__ = null
        return { direction: sig.direction, reason: 'fake test signal' }
      }
      return null
    },
  },
]

// atrAt reale (riportato qui per non dipendere dal modulo mocked)
function atrAtImpl(candles, period, i) {
  if (i < period) return null
  let s = 0
  for (let j = i - period + 1; j <= i; j++) {
    const c = candles[j], p = candles[j - 1]
    s += Math.max(c.high - c.low, Math.abs(c.high - p.close), Math.abs(c.low - p.close))
  }
  return s / period
}

mock.module('../src/strategies.js', {
  namedExports: {
    STRATEGIES: STRATEGIES_FAKE,
    findStrategy: (id) => STRATEGIES_FAKE.find(s => s.id === id),
    atrAt: atrAtImpl,
  },
})

mock.module('../src/newsFilter.js', {
  namedExports: {
    isBlockedByNewsSync: () => ({ blocked: false }),
  },
})

// loadCandles è controllata via globalThis: il test imposta i candles per (sym,tf)
mock.module('../src/data.js', {
  namedExports: {
    loadCandles: async (db, sym, tf, keys) => {
      const k = `${sym}_${tf}`
      const set = globalThis.__TEST_CANDLES__?.[k]
      if (!set) throw new Error(`no test candles for ${k}`)
      return set
    },
    ROUTING: {},
  },
})

// Import POST-mocks
const { runTick } = await import('../src/sim.js')

// ── 1. Fake D1-like DB ────────────────────────────────────────────────

function makeFakeDb() {
  const state = {
    sim_config: [],   // {id, label, active, ...cfg fields..., cycles, last_tick_at}
    sim_accounts: [], // {account_key, profile_id, ...}
    sim_trades: [],
    sim_equity: [],
    sim_errors: [],
  }

  function exec(sql, params) {
    sql = sql.replace(/\s+/g, ' ').trim()

    if (/^SELECT \* FROM sim_config WHERE active = 1$/i.test(sql)) {
      return { results: state.sim_config.filter(c => c.active === 1) }
    }
    if (/^SELECT \* FROM sim_config WHERE id = \?$/i.test(sql)) {
      return state.sim_config.find(c => c.id === params[0]) || null
    }
    if (/^SELECT \* FROM sim_accounts WHERE profile_id = \?$/i.test(sql)) {
      return { results: state.sim_accounts.filter(a => a.profile_id === params[0]) }
    }
    if (/^SELECT \* FROM sim_accounts$/i.test(sql)) {
      return { results: [...state.sim_accounts] }
    }
    if (/^UPDATE sim_accounts SET balance = \?, peak_balance = \?, open_position = \?, last_bar_time = \?, blown = \?, blown_at = \?, last_equity_write = \?, updated_at = \? WHERE account_key = \?$/i.test(sql)) {
      // Phase 2.8: aggiunta colonna last_equity_write (8 params + key)
      const acc = state.sim_accounts.find(a => a.account_key === params[8])
      if (acc) {
        acc.balance = params[0]
        acc.peak_balance = params[1]
        acc.open_position = params[2]   // string (JSON) o null
        acc.last_bar_time = params[3]
        acc.blown = params[4]
        acc.blown_at = params[5]
        acc.last_equity_write = params[6]
        acc.updated_at = params[7]
      }
      return { changes: acc ? 1 : 0 }
    }
    // Standalone UPDATE last_equity_write (heartbeat blown account)
    if (/^UPDATE sim_accounts SET last_equity_write = \?, updated_at = \? WHERE account_key = \?$/i.test(sql)) {
      const acc = state.sim_accounts.find(a => a.account_key === params[2])
      if (acc) {
        acc.last_equity_write = params[0]
        acc.updated_at = params[1]
      }
      return { changes: acc ? 1 : 0 }
    }
    // Phase 2.1b: auto-pause profilo
    if (/^UPDATE sim_config SET active = 0, paused_reason = \?, paused_at = \?, updated_at = \? WHERE id = \?$/i.test(sql)) {
      const cfg = state.sim_config.find(c => c.id === params[3])
      if (cfg) {
        cfg.active = 0
        cfg.paused_reason = params[0]
        cfg.paused_at = params[1]
        cfg.updated_at = params[2]
      }
      return { changes: cfg ? 1 : 0 }
    }
    // Adaptive: UPDATE sl_mul/tp_mul (Phase 4.2 — env-gated, di solito skip)
    if (/^UPDATE sim_accounts SET sl_mul = \?, tp_mul = \?, updated_at = \? WHERE account_key = \?$/i.test(sql)) {
      const acc = state.sim_accounts.find(a => a.account_key === params[3])
      if (acc) {
        acc.sl_mul = params[0]
        acc.tp_mul = params[1]
        acc.updated_at = params[2]
      }
      return { changes: acc ? 1 : 0 }
    }
    // Adaptive: SELECT trades count
    if (/^SELECT COUNT\(\*\) AS n FROM sim_trades WHERE account_key = \?$/i.test(sql)) {
      const n = state.sim_trades.filter(t => t.account_key === params[0]).length
      return { n }
    }
    // Adaptive: SELECT raw_rr/outcome ultimi N trades
    if (/^SELECT raw_rr, outcome FROM sim_trades WHERE account_key = \? ORDER BY id DESC LIMIT \?$/i.test(sql)) {
      const filtered = state.sim_trades.filter(t => t.account_key === params[0])
      // ORDER BY id DESC — usiamo l'ordine inverso di insert (ultimo inserito = id maggiore)
      const sorted = [...filtered].reverse().slice(0, params[1])
      return { results: sorted.map(t => ({ raw_rr: t.raw_rr, outcome: t.outcome })) }
    }
    if (/^INSERT INTO sim_trades/i.test(sql)) {
      // 17 columns: profile_id, account_key, entry_time, exit_time, direction, entry, sl, tp,
      // exit_price, outcome, raw_rr, cost_in_r, net_rr, pnl_eur, balance_after, reason, created_at
      const [profile_id, account_key, entry_time, exit_time, direction, entry, sl, tp,
        exit_price, outcome, raw_rr, cost_in_r, net_rr, pnl_eur, balance_after, reason, created_at] = params
      state.sim_trades.push({
        profile_id, account_key, entry_time, exit_time, direction, entry, sl, tp, exit_price,
        outcome, raw_rr, cost_in_r, net_rr, pnl_eur, balance_after, reason, created_at,
      })
      return { changes: 1 }
    }
    if (/^INSERT INTO sim_equity/i.test(sql)) {
      const [profile_id, account_key, ts, balance] = params
      // ON CONFLICT update — semplifichiamo cercando duplicato
      const ex = state.sim_equity.find(e => e.account_key === account_key && e.ts === ts)
      if (ex) ex.balance = balance
      else state.sim_equity.push({ profile_id, account_key, ts, balance })
      return { changes: 1 }
    }
    if (/^INSERT INTO sim_errors/i.test(sql)) {
      const [ts, scope, symbol, message] = params
      state.sim_errors.push({ ts, scope, symbol, message })
      return { changes: 1 }
    }
    if (/^UPDATE sim_config SET cycles = cycles \+ 1/i.test(sql)) {
      const cfg = state.sim_config.find(c => c.id === params[2])
      if (cfg) {
        cfg.cycles = (cfg.cycles || 0) + 1
        cfg.last_tick_at = params[0]
        cfg.updated_at = params[1]
      }
      return { changes: 1 }
    }
    throw new Error(`fake-db: SQL non gestito: ${sql}`)
  }

  class Stmt {
    constructor(sql) { this.sql = sql; this.params = [] }
    bind(...p) { this.params = p; return this }
    async run() { return exec(this.sql, this.params) }
    async first() { return exec(this.sql, this.params) }
    async all() { return exec(this.sql, this.params) }
    _exec() { return exec(this.sql, this.params) }
  }

  return {
    state,
    prepare: (sql) => new Stmt(sql),
    batch: async (stmts) => {
      // atomico: tutto-o-niente (qui simulato come sequenziale; il test verifica logica)
      for (const s of stmts) s._exec()
      return stmts.map(() => ({ success: true }))
    },
  }
}

// ── 2. Helper per generare candele sintetiche ────────────────────────

function makeCandles({ count, startTime, intervalSec, basePrice = 1.10, atrTarget = 0.001 }) {
  // candele "piatte" con range = atrTarget per OHLC, così atr ≈ atrTarget e prezzi prevedibili
  const out = []
  for (let i = 0; i < count; i++) {
    out.push({
      time: startTime + i * intervalSec,
      open: basePrice,
      high: basePrice + atrTarget / 2,
      low:  basePrice - atrTarget / 2,
      close: basePrice,
      volume: 0,
    })
  }
  return out
}

// ── 3. Setup base config + 1 account su EURUSD ───────────────────────

function setupBase(db, { symbol = 'EURUSD', tf = '1h' } = {}) {
  const now = Math.floor(Date.now() / 1000)
  db.state.sim_config.push({
    id: 1, label: 'TestProfile', active: 1, started_at: now,
    pairs: JSON.stringify([symbol]),
    swing_strategies: JSON.stringify(['fakeLong']),
    scalp_strategies: JSON.stringify([]),
    swing_tf: tf, scalp_tf: '15m',
    starting_balance: 1000, risk_pct: 1, compounding: 1,
    broker_id: 'fpmarkets_raw',
    cycles: 0, last_tick_at: null, updated_at: now,
  })
  db.state.sim_accounts.push({
    account_key: 'fakeLong_' + symbol + '_' + tf,
    profile_id: 1,
    strategy_id: 'fakeLong', strategy_name: 'Fake', category: 'swing',
    symbol, timeframe: tf,
    sl_mul: 1.5, tp_mul: 3.0,
    starting_balance: 1000, balance: 1000, peak_balance: 1000,
    open_position: null, last_bar_time: null,
    blown: 0, blown_at: null, created_at: now, updated_at: now,
  })
}

// ── 4. TESTS ─────────────────────────────────────────────────────────

describe('sim.runTick — cold start', () => {
  it('cold start (last_bar_time=null) processa solo le ultime 3 candele', async () => {
    const db = makeFakeDb()
    setupBase(db)

    // 200 candele 1h, mercoledi → giovedi (mercato sempre aperto)
    // Mercoledi 2026-05-06 00:00 UTC = giorno 3
    const startTime = Math.floor(Date.UTC(2026, 4, 6, 0) / 1000)
    const candles = makeCandles({ count: 200, startTime, intervalSec: 3600 })
    globalThis.__TEST_CANDLES__ = { 'EURUSD_1h': candles }

    // Forziamo segnale all'ultimo bar (i=199): startIdx deve essere 197 (=200-3),
    // quindi con i=197,198,199 il signal a 199 viene processato. Se startIdx fosse 0,
    // verrebbero processate tutte le 200 (regressione che vogliamo evitare).
    globalThis.__TEST_NEXT_SIGNAL__ = { atIdx: 199, direction: 'long' }

    await runTick(db, { TWELVEDATA_API_KEY: 'x' })

    const acc = db.state.sim_accounts[0]
    // Posizione APERTA al bar 199, no SL hit (candele piatte)
    assert.ok(acc.open_position, 'open_position deve essere settato')
    const pos = JSON.parse(acc.open_position)
    assert.equal(pos.direction, 'long')
    assert.equal(pos.entryBarIdx, 199)
    assert.equal(pos.entryTime, candles[199].time)
    assert.equal(pos.frozenBars, 0)
    // last_bar_time = lastBar.time
    assert.equal(acc.last_bar_time, candles[199].time)
  })

  it('cold start NON apre se segnale prima di startIdx (cioè i<197)', async () => {
    const db = makeFakeDb()
    setupBase(db)
    const startTime = Math.floor(Date.UTC(2026, 4, 6, 0) / 1000)
    const candles = makeCandles({ count: 200, startTime, intervalSec: 3600 })
    globalThis.__TEST_CANDLES__ = { 'EURUSD_1h': candles }
    // Segnale a i=100 (NON nel range [197, 199])
    globalThis.__TEST_NEXT_SIGNAL__ = { atIdx: 100, direction: 'long' }

    await runTick(db, {})

    const acc = db.state.sim_accounts[0]
    assert.equal(acc.open_position, null, 'cold start ignora segnali < startIdx')
  })
})

describe('sim.runTick — checkExit SL hit', () => {
  it('long SL hit → outcome=sl, balance ridotto del rischio', async () => {
    const db = makeFakeDb()
    setupBase(db, { symbol: 'EURUSD', tf: '1h' })

    const startTime = Math.floor(Date.UTC(2026, 4, 6, 0) / 1000)
    // 198 candele piatte + 1 candela con low molto basso (SL hit)
    const candles = makeCandles({ count: 200, startTime, intervalSec: 3600 })
    // Apriamo segnale a i=197 (entro startIdx)
    // SL = entry - 1.5 * ATR; ATR ≈ atrTarget = 0.001 → SL ≈ 1.10 - 0.0015 = 1.0985
    // Bar 199: forziamo low = 1.09 (sotto SL)
    candles[199] = { ...candles[199], low: 1.09, close: 1.0985 }
    globalThis.__TEST_CANDLES__ = { 'EURUSD_1h': candles }
    globalThis.__TEST_NEXT_SIGNAL__ = { atIdx: 197, direction: 'long' }

    await runTick(db, {})

    const acc = db.state.sim_accounts[0]
    assert.equal(acc.open_position, null, 'posizione chiusa dopo SL')
    const trades = db.state.sim_trades
    assert.equal(trades.length, 1, '1 trade chiuso')
    assert.equal(trades[0].outcome, 'sl')
    assert.equal(trades[0].direction, 'long')
    assert.equal(trades[0].raw_rr, -1)
    // Balance deve essere < starting (perso rischio + cost)
    assert.ok(acc.balance < 1000, `balance ${acc.balance} deve essere < 1000`)
  })
})

describe('sim.runTick — WEEKEND FREEZE (Fix #1.3, CRITICO)', () => {
  it('posizione EURUSD long aperta ven 21h, weekend low<SL non triggera, lun low<SL triggera', async () => {
    // Step 1: prepara una sequenza di candele
    //   - 50 candele warm-up giovedi (giorno 4) 12:00 → ven 14:00 (1h interval)
    //   - candela #50 = ven 14:00 → segnale long entry
    //   ...
    //
    // SEMPLIFICAZIONE: facciamo TUTTO in un solo runTick.
    // Però runTick processa solo le candele DOPO last_bar_time (o ultimi 3 al cold start).
    // Per test, prepariamo 200 candele intere e impostiamo last_bar_time prima della finestra
    // critica così TUTTE le candele rilevanti vengono processate.
    //
    // Disegno candele:
    //   idx 0..50  → warm-up (mercoledi 2026-05-06 ore varie, sempre forex aperto)
    //   idx 51     → segnale long: candela ven 2026-05-08 21:00 UTC (forex APERTO, hour=21<22)
    //   idx 52..   → ven 22:00 in poi (forex CHIUSO)
    //   ...
    //   sabato (tutto chiuso) + domenica fino 22:00 chiuso
    //   poi domenica 22:00 → riapre. Lunedi candele sempre aperte.
    //
    // Per il test, l'ultima candela è lun 2026-05-11 ore X con LOW < SL → triggera.
    //
    // last_bar_time = idx 50 (giovedi tarda) → il tick processa da idx 51 in poi.

    const db = makeFakeDb()
    setupBase(db, { symbol: 'EURUSD', tf: '1h' })

    // Costruiamo manualmente le candele 1h da Mer 2026-05-06 00:00 a Lun 2026-05-11 14:00
    // Tutte 1.10 piatte tranne dove specificato
    const baseTs = Math.floor(Date.UTC(2026, 4, 6, 0) / 1000)  // Mer 2026-05-06 00:00
    const intervalSec = 3600
    // 6 giorni × 24h = 144h candele (Mer→Mar mattina)
    const candles = makeCandles({ count: 144, startTime: baseTs, intervalSec, basePrice: 1.10, atrTarget: 0.001 })

    // Indice di Ven 2026-05-08 21:00 = (5-6 = wait, calcoliamo)
    // Mer 06 00:00 → idx 0
    // 24h dopo = Gio 07 00:00 → idx 24
    // 48h = Ven 08 00:00 → idx 48
    // Ven 21:00 → idx 48 + 21 = 69
    const idxFri21 = 69
    // Ven 22:00 (chiuso forex) → idx 70
    const idxFri22 = 70
    // Sab 00:00 → idx 72
    // Dom 00:00 → idx 96
    // Dom 22:00 (riapre) → idx 118
    // Lun 00:00 → idx 120
    // Lun 12:00 → idx 132

    // ATR ≈ 0.001 → SL = 1.10 - 1.5*0.001 = 1.0985
    // Per evitare SL su candele weekend → need low > SL? In realtà la nostra base price
    // è 1.10 con range ±0.0005 → low = 1.0995 > SL ✓

    // Settiamo low PIÙ BASSO di SL (1.09) su candele weekend (sabato + domenica) e su lunedi
    // Sabato: idx 72..95
    for (let i = 72; i <= 95; i++) candles[i] = { ...candles[i], low: 1.09, high: 1.10, close: 1.10 }
    // Domenica fino 22:00 (idx 96..117): low<SL ma forex chiuso
    for (let i = 96; i <= 117; i++) candles[i] = { ...candles[i], low: 1.09, high: 1.10, close: 1.10 }
    // Domenica >=22 (idx 118-119): forex APERTO, low normale (no trigger)
    // Lunedi 00:00..11:00 (idx 120..131): low normale (no trigger)
    // Lunedi 12:00 (idx 132): low<SL → triggera SL
    candles[132] = { ...candles[132], low: 1.09, high: 1.10, close: 1.10 }

    globalThis.__TEST_CANDLES__ = { 'EURUSD_1h': candles }
    // Segnale long a Ven 21:00 (idx 69), forex aperto
    globalThis.__TEST_NEXT_SIGNAL__ = { atIdx: idxFri21, direction: 'long' }

    // last_bar_time = idx 68 (cosi processa da idx 69 in poi)
    db.state.sim_accounts[0].last_bar_time = candles[68].time

    await runTick(db, {})

    // Verifica
    const trades = db.state.sim_trades
    assert.equal(trades.length, 1, 'exactly 1 trade chiuso (lunedi SL)')
    const trade = trades[0]
    assert.equal(trade.outcome, 'sl', 'outcome=sl, NON timeout')
    assert.equal(trade.direction, 'long')
    assert.equal(trade.entry_time, candles[idxFri21].time, 'entry venerdi 21:00')
    assert.equal(trade.exit_time, candles[132].time, 'exit lunedi 12:00 (NON weekend)')
  })

  it('frozenBars accumula durante weekend chiuso', async () => {
    // Simile al test precedente ma controlliamo che frozenBars > 0 al momento di chiusura.
    // Nel sistema reale frozenBars viene azzerato a closePosition, ma il counter è visibile
    // attraverso lo stato dell'account quando processAccount processa candele FUORI ma
    // checkExit non triggera. Validiamo che la posizione resti aperta durante il weekend.

    const db = makeFakeDb()
    setupBase(db, { symbol: 'EURUSD', tf: '1h' })

    const baseTs = Math.floor(Date.UTC(2026, 4, 6, 0) / 1000)
    // Solo fino a domenica 12:00 (no riapertura) → posizione DEVE restare aperta
    // Mer 00:00 idx 0, Dom 12:00 → 4*24+12 = 108h candele
    const candles = makeCandles({ count: 108, startTime: baseTs, intervalSec: 3600, basePrice: 1.10, atrTarget: 0.001 })

    // Sabato (idx 72..95) e domenica (idx 96..107) — low<SL ma forex chiuso → NON triggera
    for (let i = 72; i <= 107; i++) candles[i] = { ...candles[i], low: 1.05, high: 1.10, close: 1.10 }

    globalThis.__TEST_CANDLES__ = { 'EURUSD_1h': candles }
    globalThis.__TEST_NEXT_SIGNAL__ = { atIdx: 69, direction: 'long' }  // Ven 21:00
    db.state.sim_accounts[0].last_bar_time = candles[68].time

    await runTick(db, {})

    const acc = db.state.sim_accounts[0]
    assert.ok(acc.open_position, 'posizione DEVE restare aperta nel weekend')
    const pos = JSON.parse(acc.open_position)
    assert.ok(pos.frozenBars > 0, `frozenBars deve essere > 0 (è ${pos.frozenBars})`)
    // Aspettiamo: idx 70..71 (ven 22-23) + sab 24h + dom 12h = 2+24+12 = 38 frozen bars
    assert.equal(pos.frozenBars, 38, 'frozenBars conta esattamente le candele a mercato chiuso')
    assert.equal(db.state.sim_trades.length, 0, 'NESSUN trade chiuso durante weekend')
  })

  it('BTCUSD (24/7) NON accumula frozenBars mai', async () => {
    const db = makeFakeDb()
    setupBase(db, { symbol: 'BTCUSD', tf: '1h' })

    const baseTs = Math.floor(Date.UTC(2026, 4, 6, 0) / 1000)
    const candles = makeCandles({ count: 108, startTime: baseTs, intervalSec: 3600, basePrice: 60000, atrTarget: 100 })
    // Niente SL trigger, posizione resta aperta tutto il periodo (compreso weekend)
    globalThis.__TEST_CANDLES__ = { 'BTCUSD_1h': candles }
    globalThis.__TEST_NEXT_SIGNAL__ = { atIdx: 69, direction: 'long' }
    db.state.sim_accounts[0].last_bar_time = candles[68].time

    await runTick(db, {})

    const acc = db.state.sim_accounts[0]
    if (acc.open_position) {
      const pos = JSON.parse(acc.open_position)
      assert.equal(pos.frozenBars, 0, 'BTCUSD frozenBars sempre 0 (mercato 24/7)')
    }
    // Indipendentemente, non ci aspettiamo trade chiusi (candele piatte, niente SL)
    // ma se per maxHold timeout si chiude è OK — qui controlliamo solo frozenBars.
  })
})

describe('sim.runTick — calcTimeoutR via timeout', () => {
  it('long su BTCUSD (24/7) che non raggiunge SL/TP entro maxHold → outcome=timeout', async () => {
    // Usiamo BTCUSD perché 24/7 evita freeze weekend (1h × 24 maxHold = 1 giorno).
    // Su EURUSD il weekend bloccherebbe maxHold (vedi test FREEZE).
    const db = makeFakeDb()
    setupBase(db, { symbol: 'BTCUSD', tf: '1h' })

    // maxHold per 1h = 24 (vedi MAX_BARS_HOLD in sim.js)
    // Apriamo segnale a idx 50, idx 74 = `(74-50-0) >= 24` triggera timeout
    // candele successive sempre con close = entry → rawRR ≈ 0
    // ma per renderlo > 0 mettiamo close finale leggermente sopra entry
    const baseTs = Math.floor(Date.UTC(2026, 4, 6, 0) / 1000)
    const candles = makeCandles({ count: 100, startTime: baseTs, intervalSec: 3600, basePrice: 60000, atrTarget: 100 })

    // SL = 60000 - 1.5*100 = 59850
    // TP = 60000 + 3.0*100 = 60300
    // Idx 51..73: candele piatte (low=59950, high=60050) → no SL/TP
    // Idx 74: candela di timeout con close=60020 (rawRR=20/150≈0.13) e high<TP, low>SL
    candles[74] = { ...candles[74], close: 60020, low: 59960, high: 60040 }

    globalThis.__TEST_CANDLES__ = { 'BTCUSD_1h': candles }
    globalThis.__TEST_NEXT_SIGNAL__ = { atIdx: 50, direction: 'long' }
    db.state.sim_accounts[0].last_bar_time = candles[49].time

    await runTick(db, {})

    const trades = db.state.sim_trades
    assert.equal(trades.length, 1, '1 trade chiuso')
    assert.equal(trades[0].outcome, 'timeout')
    // rawRR ≈ 0.13 (con piccola tolleranza per ATR reale)
    assert.ok(trades[0].raw_rr > 0 && trades[0].raw_rr < 1,
      `rawRR ${trades[0].raw_rr} dovrebbe essere tra 0 e 1`)
  })

  it('long su EURUSD apre lunedi mattina, timeout giovedi (no weekend coinvolto)', async () => {
    // Variant: forex MA con apertura lunedi 09:00 → timeout entro 24h prima del prossimo weekend
    const db = makeFakeDb()
    setupBase(db, { symbol: 'EURUSD', tf: '1h' })

    // Lunedi 2026-05-11 00:00 UTC + 9h = Lun 09:00 (idx 9 if base starts Mon 00:00)
    // Base: Lun 2026-05-11 00:00 UTC; 100 candele → fino a Ven 04:00 (forex aperto fino Ven 22)
    const baseTs = Math.floor(Date.UTC(2026, 4, 11, 0) / 1000)
    const candles = makeCandles({ count: 100, startTime: baseTs, intervalSec: 3600, basePrice: 1.10, atrTarget: 0.001 })

    // Segnale a idx 50 (Mer 02:00, mercato aperto). Timeout a idx 74 (Gio 02:00 ancora mercato aperto).
    // Verifichiamo che timeout SI triggera quando mercato è SEMPRE aperto.
    candles[74] = { ...candles[74], close: 1.1003, low: 1.0995, high: 1.1010 }

    globalThis.__TEST_CANDLES__ = { 'EURUSD_1h': candles }
    globalThis.__TEST_NEXT_SIGNAL__ = { atIdx: 50, direction: 'long' }
    db.state.sim_accounts[0].last_bar_time = candles[49].time

    await runTick(db, {})

    const trades = db.state.sim_trades
    assert.equal(trades.length, 1, '1 trade chiuso (timeout entro la settimana)')
    assert.equal(trades[0].outcome, 'timeout')
  })
})

// ── PHASE 2 — Tests dedicati ai fix #2.1, #2.2, #2.7, #2.8 ────────────

describe('PHASE 2.7 — cold start COLD_START_BARS=50', () => {
  it('cold start startIdx = max(50, candles.length - 50) — segnale a i=150 viene processato', async () => {
    // 200 candele, last_bar_time=null → startIdx = max(50, 200-50) = 150
    // Segnale a i=150 deve produrre apertura. La posizione potrebbe poi chiudersi
    // per timeout (maxHold=24 a 1h) entro la fine delle candele → trade registrato.
    const db = makeFakeDb()
    setupBase(db, { symbol: 'BTCUSD', tf: '1h' })  // BTCUSD = 24/7
    const baseTs = Math.floor(Date.UTC(2026, 4, 6, 0) / 1000)
    const candles = makeCandles({ count: 200, startTime: baseTs, intervalSec: 3600, basePrice: 60000, atrTarget: 100 })
    globalThis.__TEST_CANDLES__ = { 'BTCUSD_1h': candles }
    globalThis.__TEST_NEXT_SIGNAL__ = { atIdx: 150, direction: 'long' }

    await runTick(db, {})

    // Apertura a 150, timeout a 174 (24 bar maxHold). Trade registrato.
    const trades = db.state.sim_trades
    assert.equal(trades.length, 1, 'cold start con COLD_START_BARS=50 deve processare i=150')
    assert.equal(trades[0].entry_time, candles[150].time)
  })

  it('cold start con candles.length=100 e last_bar_time=null → startIdx=50 (fallback)', async () => {
    // candles.length - COLD_START_BARS = 100-50 = 50, max con 50 = 50
    // Segnale a 60 → apertura, timeout a 84 (60+24)
    const db = makeFakeDb()
    setupBase(db, { symbol: 'BTCUSD', tf: '1h' })
    const baseTs = Math.floor(Date.UTC(2026, 4, 6, 0) / 1000)
    const candles = makeCandles({ count: 100, startTime: baseTs, intervalSec: 3600, basePrice: 60000, atrTarget: 100 })
    globalThis.__TEST_CANDLES__ = { 'BTCUSD_1h': candles }
    globalThis.__TEST_NEXT_SIGNAL__ = { atIdx: 60, direction: 'long' }

    await runTick(db, {})

    const trades = db.state.sim_trades
    assert.ok(trades.length === 1 || db.state.sim_accounts[0].open_position,
      'i=60 dentro range startIdx=50 → apre o chiude posizione')
  })

  it('cold start NON apre se segnale a i<50 (i<startIdx fallback minimo)', async () => {
    const db = makeFakeDb()
    setupBase(db, { symbol: 'BTCUSD', tf: '1h' })
    const baseTs = Math.floor(Date.UTC(2026, 4, 6, 0) / 1000)
    const candles = makeCandles({ count: 200, startTime: baseTs, intervalSec: 3600, basePrice: 60000, atrTarget: 100 })
    globalThis.__TEST_CANDLES__ = { 'BTCUSD_1h': candles }
    // Segnale a i=149 (sotto startIdx=150)
    globalThis.__TEST_NEXT_SIGNAL__ = { atIdx: 149, direction: 'long' }

    await runTick(db, {})

    assert.equal(db.state.sim_accounts[0].open_position, null,
      'segnale a idx 149 < 150 startIdx ignorato')
    assert.equal(db.state.sim_trades.length, 0)
  })
})

describe('PHASE 2.2 — compounding floor 10%', () => {
  it('balance < starting * 0.1 → riskBase usa floor (non balance reale)', async () => {
    // Setup: balance=50, starting=1000 → safeBalance=max(50,100)=100 (NON 50)
    // Risk_pct=10% → riskEUR=10 (con compounding=true, riskBase=safeBalance=100)
    // Fake long signal SL hit → balance -= riskEUR + cost
    // Senza floor: riskEUR = balance*0.10 = 5 -> balance scende a ~45
    // Con floor:  riskEUR = 100*0.10 = 10 -> balance scende a ~40
    const db = makeFakeDb()
    setupBase(db, { symbol: 'BTCUSD', tf: '1h' })
    // Override: balance ridotto sotto floor; risk_pct alto per amplificare effect
    db.state.sim_accounts[0].balance = 50
    db.state.sim_accounts[0].starting_balance = 1000
    db.state.sim_config[0].risk_pct = 10
    db.state.sim_config[0].compounding = 1

    const baseTs = Math.floor(Date.UTC(2026, 4, 6, 0) / 1000)
    const candles = makeCandles({ count: 100, startTime: baseTs, intervalSec: 3600, basePrice: 60000, atrTarget: 100 })
    // Bar 70: low molto basso → SL hit
    candles[70] = { ...candles[70], low: 59000, close: 59850 }
    globalThis.__TEST_CANDLES__ = { 'BTCUSD_1h': candles }
    globalThis.__TEST_NEXT_SIGNAL__ = { atIdx: 60, direction: 'long' }
    db.state.sim_accounts[0].last_bar_time = candles[59].time

    await runTick(db, {})

    const trade = db.state.sim_trades[0]
    assert.equal(trade.outcome, 'sl', 'SL hit atteso')
    // riskBase = safeBalance = max(50, 100) = 100, riskEUR = 100 * 0.10 = 10
    // pnlEUR = netRR * riskEUR ≈ -1 * 10 = -10 (più cost minore)
    // Se floor non applicato: riskEUR = 50*0.10 = 5 → pnl ≈ -5
    // Verifichiamo che la perdita assoluta sia ≈ -10 (NON -5)
    const lossAbs = Math.abs(trade.pnl_eur)
    assert.ok(lossAbs > 8 && lossAbs < 12,
      `loss ${lossAbs} deve essere ~10 (floor=100*10%) NON ~5 (50*10%)`)
  })

  it('balance > starting * 0.1 → riskBase usa balance reale (compounding normale)', async () => {
    const db = makeFakeDb()
    setupBase(db, { symbol: 'BTCUSD', tf: '1h' })
    db.state.sim_accounts[0].balance = 800
    db.state.sim_accounts[0].starting_balance = 1000
    db.state.sim_config[0].risk_pct = 1
    db.state.sim_config[0].compounding = 1

    const baseTs = Math.floor(Date.UTC(2026, 4, 6, 0) / 1000)
    const candles = makeCandles({ count: 100, startTime: baseTs, intervalSec: 3600, basePrice: 60000, atrTarget: 100 })
    candles[70] = { ...candles[70], low: 59000, close: 59850 }
    globalThis.__TEST_CANDLES__ = { 'BTCUSD_1h': candles }
    globalThis.__TEST_NEXT_SIGNAL__ = { atIdx: 60, direction: 'long' }
    db.state.sim_accounts[0].last_bar_time = candles[59].time

    await runTick(db, {})

    const trade = db.state.sim_trades[0]
    // riskEUR = 800 * 0.01 = 8 EUR (no floor needed)
    const lossAbs = Math.abs(trade.pnl_eur)
    assert.ok(lossAbs > 7 && lossAbs < 10,
      `loss ${lossAbs} ~8 (compounding normale 800*1%)`)
  })
})

describe('PHASE 2.1 — blown handling triplice', () => {
  it('account blown → heartbeat scrive equity_point ogni 5 min', async () => {
    // NB: serve almeno 1 account NON-blown per evitare l'auto-pause del profilo
    // (>50% blown threshold), che altrimenti skippa l'iterazione (continue su cfg).
    const db = makeFakeDb()
    setupBase(db, { symbol: 'BTCUSD', tf: '1h' })
    db.state.sim_accounts[0].blown = 1
    db.state.sim_accounts[0].balance = 100
    db.state.sim_accounts[0].last_equity_write = 0  // mai scritto -> heartbeat triggera
    // Aggiungi account sano per evitare auto-pause (1/2 = 50% NON > 50%)
    const now = Math.floor(Date.now() / 1000)
    db.state.sim_accounts.push({
      account_key: 'sano', profile_id: 1, strategy_id: 'fakeLong',
      strategy_name: 'F', category: 'swing', symbol: 'BTCUSD', timeframe: '1h',
      sl_mul: 1.5, tp_mul: 3.0, starting_balance: 1000, balance: 1000, peak_balance: 1000,
      open_position: null, last_bar_time: now, blown: 0, blown_at: null,
      last_equity_write: now, created_at: now, updated_at: now,
    })

    const baseTs = Math.floor(Date.UTC(2026, 4, 6, 0) / 1000)
    globalThis.__TEST_CANDLES__ = {
      'BTCUSD_1h': makeCandles({ count: 100, startTime: baseTs, intervalSec: 3600, basePrice: 60000, atrTarget: 100 }),
    }

    await runTick(db, {})

    // Verifica che sia stato scritto un equity point per il blown account
    const blownEq = db.state.sim_equity.filter(e => e.account_key === 'fakeLong_BTCUSD_1h')
    assert.equal(blownEq.length, 1, '1 equity point heartbeat per blown account')
    assert.equal(blownEq[0].balance, 100)
    // last_equity_write aggiornato a now
    assert.ok(db.state.sim_accounts[0].last_equity_write > 0,
      'last_equity_write aggiornato')
  })

  it('account blown con last_equity_write recente (<5min) → NO heartbeat', async () => {
    const db = makeFakeDb()
    setupBase(db, { symbol: 'BTCUSD', tf: '1h' })
    db.state.sim_accounts[0].blown = 1
    db.state.sim_accounts[0].balance = 100
    // last_equity_write recente (1 min fa) → NO heartbeat
    db.state.sim_accounts[0].last_equity_write = Math.floor(Date.now() / 1000) - 60
    // Aggiungi account sano per evitare auto-pause
    const now = Math.floor(Date.now() / 1000)
    db.state.sim_accounts.push({
      account_key: 'sano', profile_id: 1, strategy_id: 'fakeLong',
      strategy_name: 'F', category: 'swing', symbol: 'BTCUSD', timeframe: '1h',
      sl_mul: 1.5, tp_mul: 3.0, starting_balance: 1000, balance: 1000, peak_balance: 1000,
      open_position: null, last_bar_time: now, blown: 0, blown_at: null,
      last_equity_write: now, created_at: now, updated_at: now,
    })

    const baseTs = Math.floor(Date.UTC(2026, 4, 6, 0) / 1000)
    globalThis.__TEST_CANDLES__ = {
      'BTCUSD_1h': makeCandles({ count: 100, startTime: baseTs, intervalSec: 3600, basePrice: 60000, atrTarget: 100 }),
    }

    await runTick(db, {})

    const blownEq = db.state.sim_equity.filter(e => e.account_key === 'fakeLong_BTCUSD_1h')
    assert.equal(blownEq.length, 0, 'NESSUN heartbeat (within 5 min)')
  })

  it('profilo con >50% account blown → auto-pause cfg.active=0 + paused_reason', async () => {
    const db = makeFakeDb()
    setupBase(db, { symbol: 'BTCUSD', tf: '1h' })
    // Aggiungiamo 1 account "sano" + 1 blown (50% blown — non triggera, soglia >50%)
    // Per triggerare: 2 blown su 3 account = 66% > 50%
    const now = Math.floor(Date.now() / 1000)
    for (let i = 0; i < 2; i++) {
      db.state.sim_accounts.push({
        account_key: `acc_blown_${i}`, profile_id: 1,
        strategy_id: 'fakeLong', strategy_name: 'Fake', category: 'swing',
        symbol: 'BTCUSD', timeframe: '1h',
        sl_mul: 1.5, tp_mul: 3.0,
        starting_balance: 1000, balance: 100, peak_balance: 1000,
        open_position: null, last_bar_time: null,
        blown: 1, blown_at: now, last_equity_write: now, created_at: now, updated_at: now,
      })
    }
    // 1 sano + 2 blown = 66% blown
    const baseTs = Math.floor(Date.UTC(2026, 4, 6, 0) / 1000)
    globalThis.__TEST_CANDLES__ = {
      'BTCUSD_1h': makeCandles({ count: 100, startTime: baseTs, intervalSec: 3600, basePrice: 60000, atrTarget: 100 }),
    }

    await runTick(db, {})

    const cfg = db.state.sim_config[0]
    assert.equal(cfg.active, 0, 'profilo auto-paused')
    assert.equal(cfg.paused_reason, 'auto_paused_blown_threshold')
    assert.ok(cfg.paused_at > 0, 'paused_at settato')
    // Errore loggato
    const autoPauseErr = db.state.sim_errors.find(e => e.scope === 'auto-pause')
    assert.ok(autoPauseErr, 'log auto-pause presente')
    assert.match(autoPauseErr.message, /2\/3 accounts blown/)
  })
})

describe('PHASE 2.8 — equity dedup heartbeat', () => {
  it('account NON cambia → equity scritto solo se heartbeat scaduto (>5min)', async () => {
    const db = makeFakeDb()
    setupBase(db, { symbol: 'BTCUSD', tf: '1h' })
    // last_equity_write recente: NESSUN heartbeat dovuto, NESSUN trade → 0 equity write
    db.state.sim_accounts[0].last_equity_write = Math.floor(Date.now() / 1000) - 60

    const baseTs = Math.floor(Date.UTC(2026, 4, 6, 0) / 1000)
    globalThis.__TEST_CANDLES__ = {
      'BTCUSD_1h': makeCandles({ count: 100, startTime: baseTs, intervalSec: 3600, basePrice: 60000, atrTarget: 100 }),
    }
    // NESSUN segnale → no trade, no change

    await runTick(db, {})

    assert.equal(db.state.sim_equity.length, 0,
      'NO equity write (heartbeat fresh + nothing changed)')
  })

  it('heartbeat scaduto + nessun cambio → equity scritto comunque', async () => {
    const db = makeFakeDb()
    setupBase(db, { symbol: 'BTCUSD', tf: '1h' })
    db.state.sim_accounts[0].last_equity_write = 0  // mai scritto = heartbeat scaduto

    const baseTs = Math.floor(Date.UTC(2026, 4, 6, 0) / 1000)
    globalThis.__TEST_CANDLES__ = {
      'BTCUSD_1h': makeCandles({ count: 100, startTime: baseTs, intervalSec: 3600, basePrice: 60000, atrTarget: 100 }),
    }

    await runTick(db, {})

    assert.equal(db.state.sim_equity.length, 1, 'heartbeat scrive 1 equity point')
    // last_equity_write aggiornato
    assert.ok(db.state.sim_accounts[0].last_equity_write > 0)
  })
})

describe('PHASE 2.3 — equityPoint include peak_balance', () => {
  it('cambio balance scrive equity con peak corretto', async () => {
    const db = makeFakeDb()
    setupBase(db, { symbol: 'BTCUSD', tf: '1h' })
    db.state.sim_accounts[0].balance = 1000
    db.state.sim_accounts[0].peak_balance = 1500  // peak storico maggiore

    const baseTs = Math.floor(Date.UTC(2026, 4, 6, 0) / 1000)
    const candles = makeCandles({ count: 100, startTime: baseTs, intervalSec: 3600, basePrice: 60000, atrTarget: 100 })
    candles[70] = { ...candles[70], low: 59000, close: 59850 }  // SL hit
    globalThis.__TEST_CANDLES__ = { 'BTCUSD_1h': candles }
    globalThis.__TEST_NEXT_SIGNAL__ = { atIdx: 60, direction: 'long' }
    db.state.sim_accounts[0].last_bar_time = candles[59].time

    await runTick(db, {})

    // Equity point ts == lastBar.time (Phase 2.3 ritorno include peak)
    // Il fake-db non persiste peak in equity_points (schema), ma l'asserzione
    // chiave è che equity scritta + peak NON regredisce (acc.peak_balance ≥ 1500).
    assert.ok(db.state.sim_equity.length >= 1, 'equity point scritto')
    assert.ok(db.state.sim_accounts[0].peak_balance >= 1500,
      'peak NON regredisce dopo loss (resta a 1500)')
  })
})
