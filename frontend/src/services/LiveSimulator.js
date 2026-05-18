// LiveSimulator — paper trading 24/7 forward-test.
// Una volta avviato continua a girare anche se cambi panel/chiudi tab/torni dopo giorni.
// Polling incrementale ogni 60s: legge candele live, processa solo i nuovi bar,
// mantiene stato (balance, posizioni aperte, equity curve) in localStorage.
//
// Differenze vs Simulator (one-shot backfill):
// - Stateful: ogni account memorizza la sua posizione aperta e prosegue al prossimo tick
// - Persistente: sopravvive a refresh/chiusura browser
// - Forward-test reale: usa solo bar PASSATI fino al momento corrente
import { STRATEGIES }                from './StrategyLibrary'
import { SCALPING_STRATEGIES, isStrategyCompatibleWithPair } from './ScalpingLibrary'
import { getCostInR }                from './TradingCosts'
import { loadCandles }               from './DataHub'
import { useAppStore }               from '../store/store'

const STORAGE_KEY    = 'itp_live_sim_v1'
const POLL_INTERVAL  = 60_000   // 60s — sufficiente per TF da 5m+
const MAX_BARS_HOLD  = {
  '5m':  24,    // 2h max hold
  '15m': 16,    // 4h
  '1h':  24,    // 1 giorno
  '4h':  18,    // 3 giorni
  '1D':  10,    // 10 giorni
}

// ── ATR helper ─────────────────────────────────────────────────────
function atrAt(candles, period, i) {
  if (i < period) return null
  let s = 0
  for (let j = i - period + 1; j <= i; j++) {
    const c = candles[j], p = candles[j - 1]
    s += Math.max(c.high - c.low, Math.abs(c.high - p.close), Math.abs(c.low - p.close))
  }
  return s / period
}

// ── Strategy registry helper ───────────────────────────────────────
function findStrategy(strategyId) {
  return [...STRATEGIES, ...SCALPING_STRATEGIES].find(s => s.id === strategyId)
}

function isScalpStrategy(strategyId) {
  return SCALPING_STRATEGIES.some(s => s.id === strategyId)
}

// ── State serialization ───────────────────────────────────────────
function _loadState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return null
    return JSON.parse(raw)
  } catch { return null }
}

function _saveState(state) {
  try {
    // Trunca equity curves a 1000 punti per evitare bloat localStorage
    const trimmed = { ...state, accounts: {} }
    for (const [k, acc] of Object.entries(state.accounts || {})) {
      trimmed.accounts[k] = {
        ...acc,
        equityCurve: acc.equityCurve.length > 1000
          ? [...acc.equityCurve.slice(0, 100), ...acc.equityCurve.slice(-900)]
          : acc.equityCurve,
        trades: acc.trades.length > 500
          ? acc.trades.slice(-500)
          : acc.trades,
      }
    }
    localStorage.setItem(STORAGE_KEY, JSON.stringify(trimmed))
  } catch (err) {
    console.warn('[LiveSim] save failed:', err.message)
  }
}

// ── Manager (singleton) ────────────────────────────────────────────
class LiveSimulationManager {
  constructor() {
    this.state = _loadState() || this._defaultState()
    this.pollTimer = null
    this.listeners = new Set()
    this.isPolling = false
  }

  _defaultState() {
    return {
      active:    false,
      startedAt: null,
      stoppedAt: null,
      config:    null,
      accounts:  {},   // key = `${stratId}_${pair}_${tf}`
      lastTick:  null,
      cycles:    0,
      errors:    [],
    }
  }

  // ── Public API ──────────────────────────────────────────────────
  subscribe(cb) {
    this.listeners.add(cb)
    return () => this.listeners.delete(cb)
  }

  _notify() {
    for (const cb of this.listeners) {
      try { cb(this.state) } catch {}
    }
  }

  getState() { return this.state }

  start(config) {
    // config: { pairs, swingStrategies (ids), scalpStrategies (ids),
    //          startingBalance, riskPct, brokerId, swingTF, scalpTF, compounding }
    this.state.active    = true
    this.state.startedAt = this.state.startedAt || Date.now()
    this.state.stoppedAt = null
    this.state.config    = config

    // Inizializza account mancanti (preserva quelli esistenti)
    const allStrategies = [
      ...config.swingStrategies.map(id => ({ id, category: 'swing', tf: config.swingTF })),
      ...config.scalpStrategies.map(id => ({ id, category: 'scalp', tf: config.scalpTF })),
    ]
    for (const { id, category, tf } of allStrategies) {
      const strategy = findStrategy(id)
      if (!strategy) continue
      for (const pair of config.pairs) {
        // Compatibility check (scalping)
        if (category === 'scalp' && !isStrategyCompatibleWithPair(strategy, pair)) continue
        const key = `${id}_${pair}_${tf}`
        if (!this.state.accounts[key]) {
          this.state.accounts[key] = {
            key,
            strategyId:   id,
            strategyName: strategy.name,
            category,
            symbol:       pair,
            timeframe:    tf,
            slMul:        strategy.slMul || (category === 'scalp' ? 0.8 : 1.5),
            tpMul:        strategy.tpMul || (category === 'scalp' ? 1.5 : 3.0),
            startingBalance: config.startingBalance,
            balance:      config.startingBalance,
            peakBalance:  config.startingBalance,
            openPosition: null,
            lastBarTime:  null,
            trades:       [],
            equityCurve:  [{ t: Math.floor(Date.now() / 1000), b: config.startingBalance }],
            blown:        false,
            blownAt:      null,
            createdAt:    Date.now(),
            _cfgSnapshot: { compounding: config.compounding, riskPct: config.riskPct },
          }
        }
      }
    }
    _saveState(this.state)
    this._startPolling()
    this._notify()
  }

  stop() {
    this.state.active    = false
    this.state.stoppedAt = Date.now()
    if (this.pollTimer) { clearInterval(this.pollTimer); this.pollTimer = null }
    _saveState(this.state)
    this._notify()
  }

  resume() {
    if (!this.state.active && this.state.config) {
      this.state.active = true
      this.state.stoppedAt = null
      this._startPolling()
      _saveState(this.state)
      this._notify()
    }
  }

  reset() {
    if (this.pollTimer) { clearInterval(this.pollTimer); this.pollTimer = null }
    this.state = this._defaultState()
    _saveState(this.state)
    this._notify()
  }

  // Auto-resume al boot se era attivo
  autoResume() {
    if (this.state.active && this.state.config) {
      console.log('[LiveSim] auto-resume da localStorage')
      this._startPolling()
      // Tick immediato
      setTimeout(() => this._tick().catch(e => console.warn(e)), 2000)
    }
  }

  // Auto-start con defaults sensati se non è MAI stata configurata
  // Chiamato al boot se: nessuna config esiste E non è mai stata fermata esplicitamente
  autoStartWithDefaults() {
    if (this.state.config) return false   // già configurata, niente da fare
    if (this.state.startedAt) return false // era già stata configurata in passato

    console.log('[LiveSim] auto-start con defaults (prima esecuzione)')
    this.start({
      pairs: ['XAUUSD', 'BTCUSD', 'EURUSD', 'GBPUSD', 'USDJPY', 'GBPJPY', 'EURGBP', 'EURJPY'],
      swingStrategies: STRATEGIES.map(s => s.id),
      scalpStrategies: SCALPING_STRATEGIES.map(s => s.id),
      swingTF:         '4h',
      scalpTF:         '15m',
      startingBalance: 1000,
      riskPct:         1,
      compounding:     true,
      brokerId:        'fpmarkets_raw',
    })
    return true
  }

  // ── Internals ───────────────────────────────────────────────────
  _startPolling() {
    if (this.pollTimer) clearInterval(this.pollTimer)
    this.pollTimer = setInterval(() => {
      this._tick().catch(err => {
        console.error('[LiveSim] tick error:', err)
        this.state.errors = [...(this.state.errors || []).slice(-9), { at: Date.now(), msg: err.message }]
        _saveState(this.state)
      })
    }, POLL_INTERVAL)
  }

  async _tick() {
    if (!this.state.active || this.isPolling) return
    this.isPolling = true
    this.state.lastTick = Date.now()
    this.state.cycles = (this.state.cycles || 0) + 1
    try {
      // 1. Identifica le coppie (pair, tf) uniche da aggiornare
      const dataNeeds = new Map()   // "pair_tf" → { pair, tf }
      for (const acc of Object.values(this.state.accounts)) {
        if (acc.blown) continue
        const k = `${acc.symbol}_${acc.timeframe}`
        if (!dataNeeds.has(k)) dataNeeds.set(k, { pair: acc.symbol, tf: acc.timeframe })
      }

      // 2. Carica candele per ogni (pair, tf) — sequenziale per rispettare rate limit
      for (const { pair, tf } of dataNeeds.values()) {
        if (!this.state.active) break
        try {
          const result = await loadCandles(pair, tf)
          if (result?.error) {
            console.warn(`[LiveSim] ${pair} ${tf}: ${result.error}`)
            continue
          }
        } catch (err) {
          console.warn(`[LiveSim] loadCandles ${pair} ${tf}:`, err.message)
          continue
        }

        // Processa account per questo (pair, tf)
        const candles = useAppStore.getState().instruments[pair]?.candles || []
        if (candles.length < 50) continue

        for (const acc of Object.values(this.state.accounts)) {
          if (acc.symbol !== pair || acc.timeframe !== tf) continue
          if (acc.blown) continue
          this._processAccount(acc, candles)
        }
      }

      _saveState(this.state)
      this._notify()
    } finally {
      this.isPolling = false
    }
  }

  _processAccount(acc, candles) {
    const strategy = findStrategy(acc.strategyId)
    if (!strategy) return

    const lastBar = candles[candles.length - 1]
    // Identifica il punto di ripresa
    let startIdx
    if (acc.lastBarTime == null) {
      // Prima esecuzione: parti dalle ultime 3 candele (per non sparare segnali su tutta la storia)
      startIdx = Math.max(50, candles.length - 3)
    } else {
      const idx = candles.findIndex(c => c.time > acc.lastBarTime)
      if (idx < 0) return    // nessun nuovo bar
      startIdx = idx
    }

    const maxHold = MAX_BARS_HOLD[acc.timeframe] || 30

    for (let i = startIdx; i < candles.length; i++) {
      const bar = candles[i]

      // 1. Gestione posizione aperta: check SL/TP/timeout
      if (acc.openPosition) {
        const exit = this._checkExit(acc.openPosition, bar, i)
        if (exit) {
          this._closePosition(acc, exit, bar.time)
        } else {
          // Check timeout
          if (i - acc.openPosition.entryBarIdx >= maxHold) {
            const tradeR = this._calcTimeoutR(acc.openPosition, bar.close)
            this._closePosition(acc, { outcome: 'timeout', rawRR: tradeR, exitPrice: bar.close }, bar.time)
          }
        }
      }

      // 2. Nuovo segnale (solo se non c'è posizione aperta)
      if (!acc.openPosition && i >= 50) {
        const sliceCandles = candles.slice(0, i + 1)
        let sig
        try { sig = strategy.fn(sliceCandles, i) } catch { sig = null }
        if (sig?.direction) {
          this._openPosition(acc, sig, candles, i)
        }
      }
    }

    acc.lastBarTime = lastBar.time
    // Equity curve: aggiorna a ogni tick
    const lastEq = acc.equityCurve[acc.equityCurve.length - 1]
    if (!lastEq || lastEq.t !== lastBar.time) {
      acc.equityCurve.push({ t: lastBar.time, b: Math.round(acc.balance * 100) / 100 })
    } else {
      lastEq.b = Math.round(acc.balance * 100) / 100
    }
  }

  _openPosition(acc, sig, candles, i) {
    const a = atrAt(candles, 14, i)
    if (!a || a === 0) return
    const entry = candles[i].close
    const slDist = a * acc.slMul
    const tpDist = a * acc.tpMul
    const sl = sig.direction === 'long' ? entry - slDist : entry + slDist
    const tp = sig.direction === 'long' ? entry + tpDist : entry - tpDist
    const costInR = getCostInR(acc.symbol, a, slDist, this.state.config.brokerId)

    acc.openPosition = {
      direction:    sig.direction,
      reason:       sig.reason,
      entry,
      sl,
      tp,
      slDist,
      tpDist,
      atrAtEntry:   a,
      costInR,
      entryTime:    candles[i].time,
      entryBarIdx:  i,
    }
  }

  _checkExit(pos, bar) {
    if (pos.direction === 'long') {
      if (bar.low  <= pos.sl) return { outcome: 'sl', rawRR: -1, exitPrice: pos.sl }
      if (bar.high >= pos.tp) return { outcome: 'tp', rawRR: pos.tpDist / pos.slDist, exitPrice: pos.tp }
    } else {
      if (bar.high >= pos.sl) return { outcome: 'sl', rawRR: -1, exitPrice: pos.sl }
      if (bar.low  <= pos.tp) return { outcome: 'tp', rawRR: pos.tpDist / pos.slDist, exitPrice: pos.tp }
    }
    return null
  }

  _calcTimeoutR(pos, exitPrice) {
    const pnl = pos.direction === 'long' ? exitPrice - pos.entry : pos.entry - exitPrice
    return pnl / pos.slDist
  }

  _closePosition(acc, exit, exitTime) {
    const pos = acc.openPosition
    if (!pos) return
    const rawRR = exit.rawRR
    const netRR = rawRR - pos.costInR

    const cfg = this.state.config
    const riskBase = cfg.compounding ? acc.balance : acc.startingBalance
    const riskEUR  = riskBase * (cfg.riskPct / 100)
    const pnlEUR   = netRR * riskEUR
    acc.balance   += pnlEUR
    if (acc.balance > acc.peakBalance) acc.peakBalance = acc.balance

    acc.trades.push({
      time:       pos.entryTime,
      exitTime,
      direction:  pos.direction,
      entry:      Math.round(pos.entry * 100000) / 100000,
      sl:         Math.round(pos.sl * 100000) / 100000,
      tp:         Math.round(pos.tp * 100000) / 100000,
      exitPrice:  Math.round(exit.exitPrice * 100000) / 100000,
      outcome:    exit.outcome,
      rawRR:      Math.round(rawRR * 100) / 100,
      costInR:    Math.round(pos.costInR * 1000) / 1000,
      netRR:      Math.round(netRR * 100) / 100,
      pnlEUR:     Math.round(pnlEUR * 100) / 100,
      balanceAfter: Math.round(acc.balance * 100) / 100,
      reason:     pos.reason,
    })

    // Ruin check (50% drawdown dal starting balance)
    if (acc.balance < acc.startingBalance * 0.5) {
      acc.blown = true
      acc.blownAt = exitTime
    }

    acc.openPosition = null
  }
}

// Singleton
const manager = new LiveSimulationManager()

// ── Public exports ─────────────────────────────────────────────────
export function startLiveSimulation(config) { manager.start(config) }
export function stopLiveSimulation()        { manager.stop() }
export function resumeLiveSimulation()      { manager.resume() }
export function resetLiveSimulation()       { manager.reset() }
export function getLiveSimulationState()    { return manager.getState() }
export function subscribeLiveSimulation(cb) { return manager.subscribe(cb) }
export function autoResumeLiveSimulation()  { manager.autoResume() }
export function autoStartLiveSimulationWithDefaults() { return manager.autoStartWithDefaults() }

/**
 * Helper: produce un summary aggregato per l'UI dashboard.
 * Se passato currentPrice, calcola anche floating P&L sulla posizione aperta.
 */
export function summarizeAccount(acc, currentPrice = null) {
  // Fix #5.11: defensive — acc può essere undefined/parziale (server-side payload)
  if (!acc || typeof acc !== 'object') {
    return {
      total: 0, wins: 0, losses: 0, winRate: 0, profitFactor: 0,
      pnlEUR: 0, pnlPct: 0, floatingEUR: 0, floatingR: 0, floatingBalance: 0,
      totalPnL: 0, totalPnLPct: 0, maxDDPct: 0, hasOpen: false,
    }
  }
  const balance         = Number(acc.balance ?? 0) || 0
  const startingBalance = Number(acc.startingBalance ?? balance ?? 1000) || 1000
  const peakBalance     = Number(acc.peakBalance ?? balance ?? 0) || 0
  const trades = Array.isArray(acc.trades) ? acc.trades : []
  const wins   = trades.filter(t => t?.outcome === 'tp').length
  const losses = trades.filter(t => t?.outcome === 'sl').length
  const closed = wins + losses
  const winRate = closed > 0 ? wins / closed : 0
  const grossWin  = trades.filter(t => Number(t?.netRR) > 0).reduce((s, t) => s + Number(t.netRR), 0)
  const grossLoss = Math.abs(trades.filter(t => Number(t?.netRR) < 0).reduce((s, t) => s + Number(t.netRR), 0))
  const profitFactor = grossLoss > 0 ? grossWin / grossLoss : (grossWin > 0 ? Infinity : 0)

  // Floating P&L sulla posizione aperta (in R e in €)
  let floatingR = 0, floatingEUR = 0, floatingBalance = balance
  const slDist = Number(acc.openPosition?.slDist ?? 0)
  if (acc.openPosition && currentPrice != null && slDist > 0
      && acc.openPosition.entry != null && Number.isFinite(Number(acc.openPosition.entry))) {
    const pos = acc.openPosition
    const entry = Number(pos.entry)
    const priceDiff = pos.direction === 'long'
      ? currentPrice - entry
      : entry - currentPrice
    const rawR = priceDiff / slDist
    const netR = rawR - (Number(pos.costInR) || 0)
    floatingR = Number.isFinite(netR) ? netR : 0
    // Conversione in €: usa il riskBase del momento dell'apertura
    const cfg = acc._cfgSnapshot || {}
    const riskBase = cfg.compounding === false ? startingBalance : balance
    const riskEUR  = riskBase * ((Number(cfg.riskPct) || 1) / 100)
    floatingEUR    = floatingR * riskEUR
    if (!Number.isFinite(floatingEUR)) floatingEUR = 0
    floatingBalance = balance + floatingEUR
  }

  const pnlEUR = balance - startingBalance                            // realizzato
  const totalPnL = pnlEUR + floatingEUR                                // realizzato + floating
  const pnlPct = startingBalance > 0 ? (balance - startingBalance) / startingBalance * 100 : 0
  const totalPnLPct = startingBalance > 0 ? totalPnL / startingBalance * 100 : 0
  const maxDD  = peakBalance > 0 ? (peakBalance - balance) / peakBalance * 100 : 0

  return {
    total: trades.length, wins, losses,
    winRate, profitFactor,
    pnlEUR: Math.round(pnlEUR * 100) / 100,
    pnlPct: Math.round(pnlPct * 100) / 100,
    floatingEUR: Math.round(floatingEUR * 100) / 100,
    floatingR: Math.round(floatingR * 100) / 100,
    floatingBalance: Math.round(floatingBalance * 100) / 100,
    totalPnL: Math.round(totalPnL * 100) / 100,
    totalPnLPct: Math.round(totalPnLPct * 100) / 100,
    maxDDPct: Math.round(maxDD * 100) / 100,
    hasOpen: !!acc.openPosition,
  }
}

/**
 * Helper: ritorna il prezzo corrente per un simbolo dal store.
 * Fallback: ultima close delle candele se il price non è disponibile.
 */
export function getCurrentPriceForSymbol(symbol) {
  const inst = useAppStore.getState().instruments?.[symbol]
  if (!inst) return null
  if (inst.price != null) return inst.price
  const candles = inst.candles
  if (candles && candles.length > 0) return candles[candles.length - 1].close
  return null
}
