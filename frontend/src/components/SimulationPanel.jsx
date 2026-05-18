import { useState, useEffect, useMemo } from 'react'
import { useAppStore } from '../store/store'
import { STRATEGIES }                 from '../services/StrategyLibrary'
import { SCALPING_STRATEGIES, SCALP_PAIRS } from '../services/ScalpingLibrary'
import { listBrokers }                from '../services/TradingCosts'
import {
  startLiveSimulation, stopLiveSimulation, resetLiveSimulation, resumeLiveSimulation,
  getLiveSimulationState, subscribeLiveSimulation, summarizeAccount, getCurrentPriceForSymbol,
} from '../services/LiveSimulator'
import {
  isWorkerConfigured, checkWorker, getWorkerUrl,
  fetchWorkerState, startWorkerSim, stopWorkerSim, resumeWorkerSim, resetWorkerSim,
  subscribeWorkerState, fetchProfiles,
} from '../services/WorkerSim'
import { useToast } from './ui/Toast'

const TARGET_PAIRS = ['XAUUSD', 'BTCUSD', 'EURUSD', 'GBPUSD', 'USDJPY', 'GBPJPY', 'EURGBP', 'EURJPY']
const SWING_TFS    = ['1h', '4h', '1D']
const SCALP_TFS    = ['5m', '15m', '1h']

// Trasforma lo state del Worker (server) nel formato che la UI si aspetta (= LiveSimulator format)
function transformServerState(serverState) {
  if (!serverState) return { active: false, accounts: {}, config: null, cycles: 0 }
  const cfg = serverState.config || {}
  const accountsObj = {}
  for (const a of serverState.accounts || []) {
    accountsObj[a.account_key] = {
      key:             a.account_key,
      strategyId:      a.strategy_id,
      strategyName:    a.strategy_name,
      category:        a.category,
      symbol:          a.symbol,
      timeframe:       a.timeframe,
      slMul:           a.sl_mul,
      tpMul:           a.tp_mul,
      startingBalance: a.starting_balance,
      balance:         a.balance,
      peakBalance:     a.peak_balance,
      openPosition:    a.open_position,
      lastBarTime:     a.last_bar_time,
      blown:           !!a.blown,
      blownAt:         a.blown_at,
      trades:          a.trades || [],   // Fix #5.2: usa trades dal server per metriche live
      equityCurve:     [],
      _cfgSnapshot: { compounding: cfg.compounding, riskPct: cfg.risk_pct },
    }
  }
  return {
    active:    !!cfg.active,
    startedAt: cfg.started_at ? cfg.started_at * 1000 : null,
    stoppedAt: cfg.stopped_at ? cfg.stopped_at * 1000 : null,
    cycles:    cfg.cycles || 0,
    lastTick:  cfg.last_tick_at ? cfg.last_tick_at * 1000 : null,
    config: cfg.pairs ? {
      pairs: cfg.pairs,
      swingStrategies: cfg.swing_strategies,
      scalpStrategies: cfg.scalp_strategies,
      swingTF: cfg.swing_tf,
      scalpTF: cfg.scalp_tf,
      startingBalance: cfg.starting_balance,
      riskPct: cfg.risk_pct,
      compounding: cfg.compounding,
      brokerId: cfg.broker_id,
    } : null,
    accounts: accountsObj,
  }
}

export default function SimulationPanel() {
  const setPanel = useAppStore(s => s.setActivePanel)
  // Detect: usa Worker (server) o LiveSimulator (browser)
  const [useWorker] = useState(isWorkerConfigured())
  const [profiles, setProfiles] = useState([])
  const [activeProfile, setActiveProfile] = useState(1)
  const [state, setState] = useState(useWorker
    ? { active: false, accounts: {}, config: null, cycles: 0 }
    : getLiveSimulationState())
  const [showConfig, setShowConfig] = useState(false)
  const [filterCategory, setFilterCategory] = useState('all')
  const [selectedKey, setSelectedKey] = useState(null)
  const toast = useToast()

  // Carica lista profili (refresh ogni 30s)
  useEffect(() => {
    if (!useWorker) return
    let mounted = true
    const load = async () => {
      try {
        const list = await fetchProfiles()
        if (mounted) setProfiles(list)
      } catch (err) {
        console.warn('[Profiles] load error:', err.message)
      }
    }
    load()
    const id = setInterval(load, 30_000)
    return () => { mounted = false; clearInterval(id) }
  }, [useWorker])

  // Polling source: server (Worker) oppure browser (LiveSimulator), per profilo selezionato
  useEffect(() => {
    if (useWorker) {
      const unsub = subscribeWorkerState((serverState) => {
        setState(transformServerState(serverState))
      }, 5000, activeProfile)
      return unsub
    } else {
      const unsub = subscribeLiveSimulation(s => setState({ ...s }))
      const t = setInterval(() => setState({ ...getLiveSimulationState() }), 2000)
      return () => { unsub(); clearInterval(t) }
    }
  }, [useWorker, activeProfile])

  // Lifecycle handlers: scegli implementazione
  const lifecycle = useWorker
    ? {
        start:  (cfg) => startWorkerSim(cfg, activeProfile),
        stop:   ()    => stopWorkerSim(activeProfile),
        resume: ()    => resumeWorkerSim(activeProfile),
        reset:  ()    => resetWorkerSim(activeProfile),
      }
    : { start: startLiveSimulation, stop: stopLiveSimulation, resume: resumeLiveSimulation, reset: resetLiveSimulation }

  const accounts = useMemo(() => {
    const list = Object.values(state.accounts || {})
    if (filterCategory === 'all') return list
    return list.filter(a => a.category === filterCategory)
  }, [state, filterCategory])

  const ranked = useMemo(() => {
    return [...accounts].sort((a, b) => b.balance - a.balance)
  }, [accounts])

  // Aggregati (include floating dei trade aperti)
  const aggregate = useMemo(() => {
    if (!ranked.length) return null
    let totalRealizedPnL = 0
    let totalFloatingPnL = 0
    let openPositions = 0
    for (const acc of ranked) {
      const bal = Number(acc?.balance ?? 0) || 0
      const start = Number(acc?.startingBalance ?? bal ?? 0) || 0
      totalRealizedPnL += (bal - start)
      if (acc?.openPosition) {
        openPositions++
        const price = (getCurrentPriceForSymbol(acc.symbol) ?? acc.lastPrice)
        if (price != null) {
          const sum = summarizeAccount(acc, price)
          totalFloatingPnL += Number(sum.floatingEUR ?? 0)
        }
      }
    }
    const profitable = ranked.filter(a => (Number(a?.balance ?? 0) - Number(a?.startingBalance ?? 0)) > 0).length
    const blown = ranked.filter(a => a?.blown).length
    const totalTrades = ranked.reduce((s, a) => s + (Array.isArray(a?.trades) ? a.trades.length : 0), 0)
    return {
      totalAccounts: ranked.length,
      profitable,
      profitableRate: profitable / ranked.length,
      blown,
      openPositions,
      totalTrades,
      totalRealizedPnL,
      totalFloatingPnL,
      totalPnL: totalRealizedPnL + totalFloatingPnL,
    }
  }, [ranked])

  return (
    <div className="h-full flex flex-col bg-bg-primary overflow-hidden">

      {/* Header */}
      <div className="flex items-center justify-between px-6 py-3 border-b border-bg-border bg-bg-secondary shrink-0">
        <div>
          <h2 className="font-mono text-lg font-semibold text-gold tracking-wider flex items-center gap-3 flex-wrap">
            💰 SIMULAZIONE LIVE · PAPER TRADING
            {useWorker && profiles.length > 0 && (
              <select value={activeProfile}
                      onChange={e => setActiveProfile(Number(e.target.value))}
                      className="bg-bg-primary border border-gold/30 rounded-md px-2 py-1 font-mono text-xs text-gold cursor-pointer">
                {profiles.map(p => (
                  <option key={p.id} value={p.id}>
                    {p.label} · €{p.starting_balance} {p.active ? '· ▶' : '· ⏸'}
                  </option>
                ))}
              </select>
            )}
            <span className="font-mono text-xs">
              {useWorker
                ? <span className="text-green">☁ SERVER · condivisa multi-device</span>
                : <span className="text-yellow-500">⚠ BROWSER · solo questo dispositivo</span>}
            </span>
          </h2>
          <p className="font-mono text-xs text-text-muted mt-0.5">
            <LiveStatus state={state} />
            <WorkerStatusBadge />
          </p>
        </div>
        <div className="flex gap-2">
          {state.config && !state.active && (
            <button onClick={async () => { await lifecycle.resume(); toast.success('Simulazione ripresa') }}
                    className="px-3 py-1.5 rounded-md font-mono text-sm bg-green/20 text-green border border-green/40 hover:bg-green/30">
              ▶ Riprendi
            </button>
          )}
          {state.active && (
            <button onClick={async () => { await lifecycle.stop(); toast.success('Simulazione in pausa') }}
                    className="px-3 py-1.5 rounded-md font-mono text-sm bg-yellow-500/20 text-yellow-500 border border-yellow-500/40 hover:bg-yellow-500/30">
              ⏸ Pausa
            </button>
          )}
          {state.config && (
            <button onClick={() => setShowConfig(true)}
                    className="px-3 py-1.5 rounded-md font-mono text-sm text-text-secondary hover:text-text-primary border border-bg-border hover:bg-bg-hover">
              ⚙ Config
            </button>
          )}
          {Object.keys(state.accounts || {}).length > 0 && (
            <button onClick={async () => {
              if (confirm('Resettare TUTTI i dati di simulazione (account, trade, equity)?')) {
                await lifecycle.reset()
                setSelectedKey(null)
                toast.success('Simulazione resettata')
                setShowConfig(true)
              }
            }}
                    className="px-3 py-1.5 rounded-md font-mono text-sm text-red/80 hover:text-red border border-red/30 hover:bg-red/10">
              🗑 Reset
            </button>
          )}
          <button onClick={() => setPanel('chart')}
                  className="font-mono text-sm text-text-secondary hover:text-text-primary px-3 py-1.5 hover:bg-bg-hover rounded-md border border-bg-border">
            ✕ Chiudi
          </button>
        </div>
      </div>

      {/* Body */}
      <div className="flex-1 overflow-y-auto p-5">

        {/* Config (modale-like se aperto) */}
        {showConfig && (
          <ConfigDialog
            currentConfig={state.config}
            onStart={async (config) => {
              // Worker side wants snake_case keys
              const payload = useWorker ? {
                pairs: config.pairs,
                swing_strategies: config.swingStrategies,
                scalp_strategies: config.scalpStrategies,
                swing_tf: config.swingTF,
                scalp_tf: config.scalpTF,
                starting_balance: config.startingBalance,
                risk_pct: config.riskPct,
                compounding: config.compounding,
                broker_id: config.brokerId,
              } : config
              await lifecycle.start(payload)
              setShowConfig(false)
              toast.success('Simulazione live avviata')
            }}
            onCancel={() => state.config && setShowConfig(false)}
          />
        )}

        {!showConfig && state.config && (
          <>
            {/* Aggregate stats */}
            {aggregate && (
              <div className="grid grid-cols-2 md:grid-cols-6 gap-3 mb-4">
                <StatCard label="Account live" value={aggregate.totalAccounts}
                          sub={`${aggregate.openPositions} posizioni aperte`} />
                <StatCard label="In profit" value={`${aggregate.profitable}/${aggregate.totalAccounts}`}
                          color={aggregate.profitableRate >= 0.5 ? '#00e096' : '#ff7a8d'}
                          sub={`${(aggregate.profitableRate * 100).toFixed(0)}% (chiusi)`} />
                <StatCard label="Realized PnL" value={`€${aggregate.totalRealizedPnL >= 0 ? '+' : ''}${aggregate.totalRealizedPnL.toFixed(2)}`}
                          color={aggregate.totalRealizedPnL >= 0 ? '#00e096' : '#ff3355'}
                          sub={`${aggregate.totalTrades} trade chiusi`} />
                <StatCard label="Floating PnL" value={`€${aggregate.totalFloatingPnL >= 0 ? '+' : ''}${aggregate.totalFloatingPnL.toFixed(2)}`}
                          color={aggregate.totalFloatingPnL >= 0 ? '#00e096' : '#ff3355'}
                          sub={`${aggregate.openPositions} posizioni live`} />
                <StatCard label="Total Equity Δ" value={`€${aggregate.totalPnL >= 0 ? '+' : ''}${aggregate.totalPnL.toFixed(2)}`}
                          color={aggregate.totalPnL >= 0 ? '#00e096' : '#ff3355'}
                          sub={`${aggregate.blown} account blown`} />
                <StatCard label="Cicli polling" value={state.cycles || 0}
                          sub={state.lastTick ? `ultimo ${Math.floor((Date.now() - state.lastTick) / 1000)}s fa` : 'mai'} />
              </div>
            )}

            {/* Filter */}
            <div className="flex items-center justify-between mb-3 flex-wrap gap-2">
              <div className="flex gap-1 bg-bg-primary border border-bg-border rounded-md p-0.5">
                {[
                  { id: 'all',   label: `Tutti (${Object.keys(state.accounts || {}).length})` },
                  { id: 'swing', label: `Swing (${Object.values(state.accounts || {}).filter(a => a.category === 'swing').length})` },
                  { id: 'scalp', label: `Scalp (${Object.values(state.accounts || {}).filter(a => a.category === 'scalp').length})` },
                ].map(v => (
                  <button key={v.id} onClick={() => setFilterCategory(v.id)}
                          className={`px-3 py-1 rounded font-mono text-xs ${filterCategory === v.id ? 'bg-gold/20 text-gold' : 'text-text-secondary hover:text-text-primary'}`}>
                    {v.label}
                  </button>
                ))}
              </div>
            </div>

            {/* Leaderboard */}
            <Leaderboard accounts={ranked} selectedKey={selectedKey} onSelect={setSelectedKey} />

            {/* Detail panel */}
            {selectedKey && state.accounts[selectedKey] && (
              <AccountDetail account={state.accounts[selectedKey]} />
            )}
          </>
        )}

        {!showConfig && !state.config && (
          <div className="bg-bg-secondary/50 rounded-xl border border-bg-border p-8 text-center">
            <div className="text-5xl mb-4 opacity-50">💰</div>
            <h3 className="font-mono text-lg text-gold mb-2">Nessuna simulazione attiva</h3>
            <p className="font-mono text-sm text-text-secondary max-w-2xl mx-auto leading-relaxed mb-4">
              Configura quali strategie far girare in paper trading 24/7. Lo stato persiste a refresh/chiusura tab.
              Poll ogni 60s legge i nuovi bar e processa SL/TP/segnali.
            </p>
            <button onClick={() => setShowConfig(true)}
                    className="px-6 py-2.5 rounded-md font-mono text-sm font-semibold bg-gold/20 text-gold border-2 border-gold/50 hover:bg-gold/30">
              ▶ Avvia simulazione
            </button>
          </div>
        )}
      </div>
    </div>
  )
}

// ─── Worker status badge ────────────────────────────────────────────
function WorkerStatusBadge() {
  const [status, setStatus] = useState(null)
  useEffect(() => {
    if (!isWorkerConfigured()) return
    let cancelled = false
    const tick = async () => {
      const r = await checkWorker()
      if (!cancelled) setStatus(r)
    }
    tick()
    const id = setInterval(tick, 30_000)
    return () => { cancelled = true; clearInterval(id) }
  }, [])
  if (!isWorkerConfigured()) {
    return <span className="ml-3 text-text-muted">· Worker: <span className="text-text-muted/70">non configurato (browser-only)</span></span>
  }
  if (!status) return <span className="ml-3 text-text-muted">· Worker: ⏳</span>
  if (status.ok) {
    return <span className="ml-3 text-text-muted">· <span className="text-green">Worker LIVE</span> · 24/7</span>
  }
  return <span className="ml-3 text-text-muted">· <span className="text-red">Worker offline</span></span>
}

// ─── Live status indicator ──────────────────────────────────────────
function LiveStatus({ state }) {
  if (!state.config) return <span>Non configurata</span>
  const since = state.startedAt
  const elapsed = since ? Date.now() - since : 0
  const days  = Math.floor(elapsed / 86400000)
  const hours = Math.floor((elapsed % 86400000) / 3600000)
  const mins  = Math.floor((elapsed % 3600000) / 60000)
  const elapsedStr = days > 0 ? `${days}g ${hours}h` : hours > 0 ? `${hours}h ${mins}m` : `${mins}m`
  if (state.active) {
    return (
      <span>
        <span className="inline-block w-1.5 h-1.5 rounded-full bg-green animate-pulse mr-1" />
        <span className="text-green">LIVE</span> · attiva da {elapsedStr} · {state.cycles || 0} cicli completati
      </span>
    )
  }
  return (
    <span>
      <span className="inline-block w-1.5 h-1.5 rounded-full bg-yellow-500 mr-1" />
      <span className="text-yellow-500">PAUSA</span> · in pausa, click "Riprendi" per continuare
    </span>
  )
}

// ─── Config dialog ──────────────────────────────────────────────────
function ConfigDialog({ currentConfig, onStart, onCancel }) {
  const c = currentConfig || {}
  const [pairs, setPairs] = useState(c.pairs || [...TARGET_PAIRS])
  const [swingStrategies, setSwingStrategies] = useState(
    c.swingStrategies || STRATEGIES.map(s => s.id)
  )
  const [scalpStrategies, setScalpStrategies] = useState(
    c.scalpStrategies || SCALPING_STRATEGIES.map(s => s.id)
  )
  const [swingTF, setSwingTF] = useState(c.swingTF || '4h')
  const [scalpTF, setScalpTF] = useState(c.scalpTF || '15m')
  const [startingBalance, setStartingBalance] = useState(c.startingBalance || 1000)
  const [riskPct, setRiskPct] = useState(c.riskPct || 1)
  const [compounding, setCompounding] = useState(c.compounding !== false)
  const [brokerId, setBrokerId] = useState(c.brokerId || 'fpmarkets_raw')

  const togglePair = (id) => setPairs(p => p.includes(id) ? p.filter(x => x !== id) : [...p, id])
  const toggleSwing = (id) => setSwingStrategies(s => s.includes(id) ? s.filter(x => x !== id) : [...s, id])
  const toggleScalp = (id) => setScalpStrategies(s => s.includes(id) ? s.filter(x => x !== id) : [...s, id])

  const totalAccounts = (swingStrategies.length + scalpStrategies.length) * pairs.length

  const handleStart = () => {
    onStart({
      pairs, swingStrategies, scalpStrategies, swingTF, scalpTF,
      startingBalance, riskPct, compounding, brokerId,
    })
  }

  return (
    <div className="bg-bg-secondary rounded-xl border-2 border-gold/30 p-5 mb-4">
      <div className="flex items-center justify-between mb-4">
        <h3 className="font-mono text-base font-semibold text-gold">⚙ Configurazione simulazione</h3>
        {currentConfig && (
          <button onClick={onCancel} className="font-mono text-xs text-text-secondary hover:text-text-primary">Annulla</button>
        )}
      </div>

      {/* Money management */}
      <div className="grid grid-cols-1 md:grid-cols-4 gap-3 mb-4">
        <div>
          <label className="font-mono text-xxs text-text-muted uppercase tracking-wider block mb-1">Balance iniziale (€)</label>
          <input type="number" value={startingBalance} onChange={e => setStartingBalance(Number(e.target.value) || 1000)}
                 className="w-full bg-bg-primary border border-bg-border rounded-md px-2 py-1 font-mono text-xs text-text-primary" />
        </div>
        <div>
          <label className="font-mono text-xxs text-text-muted uppercase tracking-wider block mb-1">Risk % per trade</label>
          <input type="number" step="0.1" value={riskPct} onChange={e => setRiskPct(Number(e.target.value) || 1)}
                 className="w-full bg-bg-primary border border-bg-border rounded-md px-2 py-1 font-mono text-xs text-text-primary" />
        </div>
        <div>
          <label className="font-mono text-xxs text-text-muted uppercase tracking-wider block mb-1">Broker</label>
          <select value={brokerId} onChange={e => setBrokerId(e.target.value)}
                  className="w-full bg-bg-primary border border-bg-border rounded-md px-2 py-1 font-mono text-xs text-text-primary">
            {listBrokers().map(b => <option key={b.id} value={b.id}>{b.label}</option>)}
          </select>
        </div>
        <div className="flex items-end">
          <label className="flex items-center gap-1.5 font-mono text-xxs text-text-secondary cursor-pointer">
            <input type="checkbox" checked={compounding} onChange={e => setCompounding(e.target.checked)} />
            <span>Compounding</span>
          </label>
        </div>
      </div>

      {/* TF */}
      <div className="grid grid-cols-2 gap-3 mb-4">
        <div>
          <label className="font-mono text-xxs text-text-muted uppercase tracking-wider block mb-1">TF strategie swing</label>
          <select value={swingTF} onChange={e => setSwingTF(e.target.value)}
                  className="w-full bg-bg-primary border border-bg-border rounded-md px-2 py-1 font-mono text-xs text-text-primary">
            {SWING_TFS.map(tf => <option key={tf} value={tf}>{tf}</option>)}
          </select>
        </div>
        <div>
          <label className="font-mono text-xxs text-text-muted uppercase tracking-wider block mb-1">TF strategie scalp</label>
          <select value={scalpTF} onChange={e => setScalpTF(e.target.value)}
                  className="w-full bg-bg-primary border border-bg-border rounded-md px-2 py-1 font-mono text-xs text-text-primary">
            {SCALP_TFS.map(tf => <option key={tf} value={tf}>{tf}</option>)}
          </select>
        </div>
      </div>

      {/* Pairs */}
      <div className="mb-3">
        <div className="flex items-center justify-between mb-1">
          <span className="font-mono text-xxs text-text-muted uppercase tracking-wider">Asset ({pairs.length}/{TARGET_PAIRS.length})</span>
          <div className="flex gap-2">
            <button onClick={() => setPairs([...TARGET_PAIRS])} className="font-mono text-xxs text-text-secondary hover:text-text-primary">tutti</button>
            <button onClick={() => setPairs([])} className="font-mono text-xxs text-text-secondary hover:text-text-primary">nessuno</button>
          </div>
        </div>
        <div className="flex flex-wrap gap-1.5">
          {TARGET_PAIRS.map(p => {
            const active = pairs.includes(p)
            return (
              <button key={p} onClick={() => togglePair(p)}
                      className={`px-2.5 py-1 rounded font-mono text-xxs ${active ? 'bg-gold/20 text-gold border border-gold/40' : 'bg-bg-primary text-text-secondary border border-bg-border'}`}>
                {p}
              </button>
            )
          })}
        </div>
      </div>

      {/* Swing strategies */}
      <div className="mb-3">
        <div className="flex items-center justify-between mb-1">
          <span className="font-mono text-xxs text-text-muted uppercase tracking-wider">Strategie SWING ({swingStrategies.length}/{STRATEGIES.length})</span>
          <div className="flex gap-2">
            <button onClick={() => setSwingStrategies(STRATEGIES.map(s => s.id))} className="font-mono text-xxs text-text-secondary hover:text-text-primary">tutte</button>
            <button onClick={() => setSwingStrategies([])} className="font-mono text-xxs text-text-secondary hover:text-text-primary">nessuna</button>
          </div>
        </div>
        <div className="flex flex-wrap gap-1.5">
          {STRATEGIES.map(s => {
            const active = swingStrategies.includes(s.id)
            return (
              <button key={s.id} onClick={() => toggleSwing(s.id)}
                      className={`px-2 py-1 rounded font-mono text-xxs flex items-center gap-1 ${active ? 'bg-blue-500/20 text-blue-400 border border-blue-500/40' : 'bg-bg-primary text-text-secondary border border-bg-border'}`}
                      title={s.desc}>
                <span>{s.icon}</span><span>{s.name}</span>
              </button>
            )
          })}
        </div>
      </div>

      {/* Scalp strategies */}
      <div className="mb-4">
        <div className="flex items-center justify-between mb-1">
          <span className="font-mono text-xxs text-text-muted uppercase tracking-wider">Strategie SCALP ({scalpStrategies.length}/{SCALPING_STRATEGIES.length})</span>
          <div className="flex gap-2">
            <button onClick={() => setScalpStrategies(SCALPING_STRATEGIES.map(s => s.id))} className="font-mono text-xxs text-text-secondary hover:text-text-primary">tutte</button>
            <button onClick={() => setScalpStrategies([])} className="font-mono text-xxs text-text-secondary hover:text-text-primary">nessuna</button>
          </div>
        </div>
        <div className="flex flex-wrap gap-1.5">
          {SCALPING_STRATEGIES.map(s => {
            const active = scalpStrategies.includes(s.id)
            return (
              <button key={s.id} onClick={() => toggleScalp(s.id)}
                      className={`px-2 py-1 rounded font-mono text-xxs flex items-center gap-1 ${active ? 'bg-purple-500/20 text-purple-400 border border-purple-500/40' : 'bg-bg-primary text-text-secondary border border-bg-border'}`}
                      title={s.desc}>
                <span>{s.icon}</span><span>{s.name}</span>
              </button>
            )
          })}
        </div>
      </div>

      <div className="flex items-center justify-between pt-3 border-t border-bg-border">
        <div className="font-mono text-xs text-text-secondary">
          {totalAccounts} account verranno simulati ({swingStrategies.length} swing + {scalpStrategies.length} scalp) × {pairs.length} pair
        </div>
        <button onClick={handleStart}
                disabled={totalAccounts === 0}
                className="px-5 py-2 rounded-md font-mono text-sm font-semibold bg-gold/20 text-gold border border-gold/50 hover:bg-gold/30 disabled:opacity-50">
          ▶ Avvia / Aggiorna config
        </button>
      </div>
    </div>
  )
}

// ─── Leaderboard ───────────────────────────────────────────────────
function Leaderboard({ accounts, selectedKey, onSelect }) {
  if (accounts.length === 0) {
    return (
      <div className="bg-bg-secondary rounded-xl border border-bg-border p-8 text-center font-mono text-sm text-text-muted">
        Nessun account ancora. Attendere il primo ciclo di polling (entro 60s)...
      </div>
    )
  }
  return (
    <div className="bg-bg-secondary rounded-xl border border-bg-border overflow-x-auto">
      <table className="w-full font-mono text-xs">
        <thead>
          <tr className="text-text-muted bg-bg-primary/50 border-b border-bg-border">
            <th className="text-left  py-2 px-3">#</th>
            <th className="text-left  py-2 px-3">Strategia · Asset</th>
            <th className="text-left  py-2 px-3">Tipo</th>
            <th className="text-center py-2 px-3" title="Posizione aperta + floating PnL">Live</th>
            <th className="text-right py-2 px-3">€ Balance</th>
            <th className="text-right py-2 px-3" title="Realizzato + floating se aperta">€ Equity</th>
            <th className="text-right py-2 px-3">€ PnL</th>
            <th className="text-right py-2 px-3">%</th>
            <th className="text-right py-2 px-3">Trade</th>
            <th className="text-right py-2 px-3">WR</th>
            <th className="text-right py-2 px-3">PF</th>
            <th className="text-right py-2 px-3">DD%</th>
          </tr>
        </thead>
        <tbody>
          {accounts.slice(0, 100).map((acc, i) => {
            const currentPrice = (getCurrentPriceForSymbol(acc.symbol) ?? acc.lastPrice)
            const sum = summarizeAccount(acc, currentPrice)
            const pnlColor = sum.totalPnL >= 0 ? '#00e096' : '#ff3355'
            const realizedColor = sum.pnlEUR >= 0 ? '#00e096' : '#ff3355'
            const wrColor  = sum.winRate >= 0.55 ? '#00e096' : sum.winRate < 0.45 ? '#ff3355' : '#f5c842'
            const pfColor  = sum.profitFactor >= 1.3 ? '#00e096' : sum.profitFactor < 1 ? '#ff3355' : '#f5c842'
            const floatingColor = sum.floatingEUR >= 0 ? '#00e096' : '#ff3355'
            const isSelected = selectedKey === acc.key
            return (
              <tr key={acc.key}
                  onClick={() => onSelect(isSelected ? null : acc.key)}
                  className={`border-b border-bg-border/50 hover:bg-bg-hover cursor-pointer ${
                    i < 3 ? 'bg-gold/5' : ''} ${isSelected ? 'bg-gold/10' : ''} ${acc.blown ? 'opacity-60' : ''}`}>
                <td className="py-2 px-3 text-text-muted tabular-nums">{i + 1}</td>
                <td className="py-2 px-3">
                  <div className="font-semibold text-text-primary">{acc.strategyName}</div>
                  <div className="font-mono text-xxs text-text-muted">{acc.symbol} · {acc.timeframe}</div>
                </td>
                <td className="py-2 px-3">
                  <span className="px-1.5 py-0.5 rounded font-mono text-xxs"
                        style={{
                          backgroundColor: acc.category === 'scalp' ? '#9C27B020' : '#2196F320',
                          color: acc.category === 'scalp' ? '#BA68C8' : '#64B5F6',
                        }}>
                    {acc.category}
                  </span>
                </td>
                <td className="py-2 px-3 text-center">
                  {acc.openPosition ? (
                    <div className="flex flex-col items-center gap-0.5">
                      <span className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded font-mono text-xxs ${
                        acc.openPosition.direction === 'long' ? 'bg-green/20 text-green' : 'bg-red/20 text-red'
                      }`}>
                        {acc.openPosition.direction === 'long' ? '▲' : '▼'} OPEN
                      </span>
                      {currentPrice != null && (
                        <span className="font-mono text-xxs tabular-nums" style={{ color: floatingColor }}>
                          {(sum.floatingEUR ?? 0) >= 0 ? '+' : ''}€{Number(sum.floatingEUR ?? 0).toFixed(2)}
                          <span className="text-text-muted ml-1">({Number(sum.floatingR ?? 0).toFixed(2)}R)</span>
                        </span>
                      )}
                    </div>
                  ) : <span className="text-text-muted">—</span>}
                </td>
                <td className="py-2 px-3 text-right tabular-nums font-semibold" style={{ color: realizedColor }}>
                  €{Number(acc?.balance ?? 0).toFixed(2)}
                  {acc.blown && <div className="text-xxs text-red">⚠ blown</div>}
                </td>
                <td className="py-2 px-3 text-right tabular-nums font-semibold" style={{ color: pnlColor }}>
                  €{Number(sum.floatingBalance ?? acc?.balance ?? 0).toFixed(2)}
                  {sum.hasOpen && currentPrice != null && (
                    <div className="text-xxs" style={{ color: floatingColor }}>
                      {(sum.floatingEUR ?? 0) >= 0 ? '+' : ''}€{Number(sum.floatingEUR ?? 0).toFixed(2)} live
                    </div>
                  )}
                </td>
                <td className="py-2 px-3 text-right tabular-nums font-semibold" style={{ color: pnlColor }}>
                  {(sum.totalPnL ?? 0) >= 0 ? '+' : ''}€{Number(sum.totalPnL ?? 0).toFixed(2)}
                </td>
                <td className="py-2 px-3 text-right tabular-nums" style={{ color: pnlColor }}>
                  {(sum.totalPnLPct ?? 0) >= 0 ? '+' : ''}{Number(sum.totalPnLPct ?? 0).toFixed(1)}%
                </td>
                <td className="py-2 px-3 text-right tabular-nums">{sum.total ?? 0}</td>
                <td className="py-2 px-3 text-right tabular-nums" style={{ color: wrColor }}>
                  {(sum.total ?? 0) > 0 ? `${((sum.winRate ?? 0) * 100).toFixed(0)}%` : '—'}
                </td>
                <td className="py-2 px-3 text-right tabular-nums" style={{ color: pfColor }}>
                  {(sum.total ?? 0) > 0 && isFinite(sum.profitFactor) ? Number(sum.profitFactor).toFixed(2) :
                   (sum.total ?? 0) > 0 ? '∞' : '—'}
                </td>
                <td className="py-2 px-3 text-right tabular-nums text-red/70">{Number(sum.maxDDPct ?? 0).toFixed(1)}%</td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

// ─── Detail ─────────────────────────────────────────────────────────
function AccountDetail({ account }) {
  // Fix #5.11: defensive guards — server-side accounts can have null/undefined fields
  const eq = Array.isArray(account?.equityCurve) ? account.equityCurve : []
  const currentPrice = (getCurrentPriceForSymbol(account?.symbol) ?? account?.lastPrice)
  const sum = summarizeAccount(account, currentPrice)
  // Fix #5.10: rimuovi early return — gli account server-side hanno equityCurve=[]
  // ma vogliamo comunque mostrare detail (open position + button "Vedi grafico")
  const hasEquityCurve = eq.length > 0

  // Numeric safe-guards
  const safeBalance         = Number(account?.balance ?? 0)
  const safeStartingBalance = Number(account?.startingBalance ?? safeBalance ?? 1000) || 1000
  const safePeakBalance     = Number(account?.peakBalance ?? safeBalance ?? 0)

  const w = 800, h = 200, padding = 30
  const finalBalanceDisplay = Number(sum.floatingBalance ?? safeBalance) || safeBalance
  const minBal = hasEquityCurve
    ? Math.min(...eq.map(p => Number(p?.b ?? safeBalance)), finalBalanceDisplay, safeStartingBalance) * 0.95
    : finalBalanceDisplay * 0.95
  const maxBal = hasEquityCurve
    ? Math.max(...eq.map(p => Number(p?.b ?? safeBalance)), finalBalanceDisplay, safeStartingBalance) * 1.05
    : Math.max(finalBalanceDisplay, safeStartingBalance) * 1.05
  const xR = w - 2 * padding, yR = h - 2 * padding
  const points = hasEquityCurve ? eq.map((p, i) => {
    const x = padding + (i / Math.max(1, eq.length - 1)) * xR
    const y = h - padding - ((Number(p?.b ?? safeBalance) - minBal) / Math.max(0.01, maxBal - minBal)) * yR
    return `${x},${y}`
  }).join(' ') : ''
  const baseY  = h - padding - ((safeStartingBalance - minBal) / Math.max(0.01, maxBal - minBal)) * yR
  const finalY = h - padding - ((finalBalanceDisplay - minBal) / Math.max(0.01, maxBal - minBal)) * yR
  const lineColor = (sum.totalPnL ?? 0) >= 0 ? '#00e096' : '#ff3355'

  // Calcoli per la barra di progressione SL→TP della posizione aperta
  // Fix #5.11: guard pos.tp / pos.sl null
  let progressData = null
  if (account?.openPosition && currentPrice != null
      && account.openPosition.tp != null && account.openPosition.sl != null) {
    const pos = account.openPosition
    const totalRange = Math.abs(Number(pos.tp) - Number(pos.sl))
    const fromSL = pos.direction === 'long'
      ? Math.max(0, currentPrice - Number(pos.sl))
      : Math.max(0, Number(pos.sl) - currentPrice)
    const progress = totalRange > 0 ? Math.min(1, fromSL / totalRange) : 0
    const distToTP = pos.direction === 'long' ? Number(pos.tp) - currentPrice : currentPrice - Number(pos.tp)
    const distToSL = pos.direction === 'long' ? currentPrice - Number(pos.sl) : Number(pos.sl) - currentPrice
    progressData = {
      progress,
      distToTP: Math.abs(distToTP),
      distToSL: Math.abs(distToSL),
      pctToTP: totalRange > 0 ? Math.abs(distToTP) / totalRange * 100 : 0,
      pctToSL: totalRange > 0 ? Math.abs(distToSL) / totalRange * 100 : 0,
    }
  }

  return (
    <div className="mt-4 bg-bg-secondary rounded-xl border border-bg-border p-4">
      <div className="flex items-center justify-between mb-3 flex-wrap gap-2">
        <div>
          <span className="font-mono text-base font-semibold text-gold">{account?.strategyName || account?.strategyId || '—'}</span>
          <span className="font-mono text-sm text-text-muted ml-2">{account?.symbol || '—'} · {account?.timeframe || '—'}</span>
          <span className="font-mono text-xxs text-text-muted ml-2">SL {account?.slMul ?? '—'}× / TP {account?.tpMul ?? '—'}×</span>
        </div>
        <div className="flex gap-3 font-mono text-xs">
          <span>Trade: <strong>{sum.total ?? 0}</strong></span>
          <span>WR: <strong>{(sum.total ?? 0) > 0 ? `${((sum.winRate ?? 0) * 100).toFixed(0)}%` : '—'}</strong></span>
          <span>Balance: <strong>€{safeBalance.toFixed(2)}</strong></span>
          {sum.hasOpen && (
            <span>Equity (live): <strong style={{ color: lineColor }}>€{Number(sum.floatingBalance ?? safeBalance).toFixed(2)}</strong></span>
          )}
          <span>Peak: <strong>€{safePeakBalance.toFixed(2)}</strong></span>
          <span>DD: <strong className="text-red/70">{Number(sum.maxDDPct ?? 0).toFixed(1)}%</strong></span>
        </div>
      </div>

      {/* Open position con floating P&L LIVE */}
      {account?.openPosition && (() => {
        const pos = account.openPosition
        const dir = pos?.direction
        const dirColor = dir === 'long' ? '#00e096' : '#ff3355'
        // Fix #5.11: fmt safe per null/undefined/NaN
        const fmt = (n) => {
          const v = Number(n)
          if (n == null || !Number.isFinite(v)) return '—'
          return v.toFixed(v < 10 ? 5 : v < 100 ? 4 : 2)
        }
        const openChart = () => {
          // Fix #5.4 + 5.9: jump al chart + setta activePosition per overlay entry/SL/TP
          // Fix #5.11: guard symbol/timeframe e numeric levels
          if (!account?.symbol || !pos) return
          const store = useAppStore.getState()
          store.setActiveInstrument(account.symbol)
          if (account.timeframe) store.setActiveTimeframe(account.timeframe)
          store.setActivePosition({
            accountKey:   account.accountKey || account.key || null,
            symbol:       account.symbol,
            timeframe:    account.timeframe || '1h',
            strategyId:   account.strategyId || account.strategy_id || null,
            strategyName: account.strategyName || account.strategy_name || account.strategyId || '',
            direction:    pos.direction || 'long',
            entry:        Number(pos.entry),
            sl:           Number(pos.sl),
            tp:           Number(pos.tp),
            reason:       pos.reason || '',
            entryTime:    pos.entryTime || null,
            slMul: account.slMul, tpMul: account.tpMul,
          })
          store.setActivePanel('chart')
        }
        return (
          <div className="mb-3 px-3 py-3 rounded-md font-mono text-xs"
               style={{ backgroundColor: `${dirColor}18`, border: `1px solid ${dirColor}60` }}>
            <div className="flex items-center justify-between mb-2 flex-wrap gap-2">
              <div>
                <strong style={{ color: dirColor }} className="text-sm">
                  {dir === 'long' ? '▲ LONG' : '▼ SHORT'}
                </strong>
                <span className="text-text-muted ml-2">{pos?.reason || '—'}</span>
                <button
                  onClick={openChart}
                  className="ml-3 px-2 py-0.5 rounded bg-gold/10 hover:bg-gold/25 border border-gold/40 text-gold text-xxs uppercase tracking-wider transition"
                  title={`Apri grafico ${account?.symbol ?? ''} ${account?.timeframe ?? ''}`}
                >
                  📊 Vedi grafico {account?.symbol ?? ''}
                </button>
              </div>
              {currentPrice != null && (
                <div className="text-right">
                  <div className="text-xxs text-text-muted uppercase tracking-wider">Floating P&L (live)</div>
                  <div className="text-base font-bold tabular-nums" style={{ color: (sum.floatingEUR ?? 0) >= 0 ? '#00e096' : '#ff3355' }}>
                    {(sum.floatingEUR ?? 0) >= 0 ? '+' : ''}€{Number(sum.floatingEUR ?? 0).toFixed(2)}
                    <span className="text-text-muted text-xxs ml-1">
                      ({(sum.floatingR ?? 0) >= 0 ? '+' : ''}{Number(sum.floatingR ?? 0).toFixed(2)}R)
                    </span>
                  </div>
                </div>
              )}
            </div>

            {/* Levels grid */}
            <div className="grid grid-cols-2 md:grid-cols-4 gap-2 mb-2">
              <div className="bg-bg-primary/50 rounded px-2 py-1">
                <div className="text-xxs text-text-muted">Entry</div>
                <div className="font-semibold tabular-nums">{fmt(pos.entry)}</div>
              </div>
              <div className="bg-bg-primary/50 rounded px-2 py-1">
                <div className="text-xxs text-text-muted">Current</div>
                <div className="font-semibold tabular-nums" style={{ color: dirColor }}>
                  {fmt(currentPrice)}
                </div>
              </div>
              <div className="bg-bg-primary/50 rounded px-2 py-1">
                <div className="text-xxs text-red/70">SL</div>
                <div className="font-semibold tabular-nums text-red">{fmt(pos.sl)}</div>
                {progressData && (
                  <div className="text-xxs text-text-muted">a {progressData.pctToSL.toFixed(0)}%</div>
                )}
              </div>
              <div className="bg-bg-primary/50 rounded px-2 py-1">
                <div className="text-xxs text-green/70">TP</div>
                <div className="font-semibold tabular-nums text-green">{fmt(pos.tp)}</div>
                {progressData && (
                  <div className="text-xxs text-text-muted">a {progressData.pctToTP.toFixed(0)}%</div>
                )}
              </div>
            </div>

            {/* Progress bar SL → TP */}
            {progressData && (
              <div className="mt-2">
                <div className="relative h-3 bg-bg-primary rounded-full overflow-hidden">
                  <div className="absolute inset-y-0 left-0 bg-red/40" style={{ width: '50%' }} />
                  <div className="absolute inset-y-0 right-0 bg-green/40" style={{ width: '50%' }} />
                  {/* Cursor su current price */}
                  <div className="absolute top-0 bottom-0 w-0.5 bg-gold"
                       style={{ left: `${progressData.progress * 100}%` }} />
                </div>
                <div className="flex justify-between font-mono text-xxs text-text-muted mt-1">
                  <span className="text-red/70">SL</span>
                  <span style={{ color: dirColor }}>● now</span>
                  <span className="text-green/70">TP</span>
                </div>
              </div>
            )}
            {currentPrice == null && (
              <div className="text-xxs text-text-muted italic mt-1">
                ⚠ Prezzo corrente non disponibile (asset non attivo nel chart). Floating P&L visibile solo a chiusura bar.
              </div>
            )}
          </div>
        )
      })()}

      {/* Equity curve SVG (solo se ci sono punti) */}
      {hasEquityCurve && (
        <svg width="100%" viewBox={`0 0 ${w} ${h}`} className="bg-bg-primary rounded-md">
          {[0.25, 0.5, 0.75].map(p => (
            <line key={p} x1={padding} y1={padding + p * yR} x2={w - padding} y2={padding + p * yR}
                  stroke="#1e253566" strokeWidth="1" />
          ))}
          <line x1={padding} y1={baseY} x2={w - padding} y2={baseY}
                stroke="#8892a455" strokeWidth="1" strokeDasharray="3,3" />
          <text x={padding + 4} y={baseY - 4} fill="#8892a4" fontSize="10" fontFamily="monospace">€{safeStartingBalance}</text>
          <polyline points={points} fill="none" stroke={lineColor} strokeWidth="2" />
          <text x={w - padding - 4} y={finalY - 4} fill={lineColor} fontSize="10" fontFamily="monospace" textAnchor="end">
            €{safeBalance.toFixed(0)}
          </text>
        </svg>
      )}

      {/* Recent trades */}
      <div className="mt-4">
        <div className="font-mono text-xxs text-text-muted uppercase tracking-wider mb-2">Ultimi 15 trade</div>
        {(account.trades || []).length === 0 ? (
          <div className="font-mono text-xxs text-text-muted text-center py-3">Ancora nessun trade chiuso</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full font-mono text-xs">
              <thead>
                <tr className="text-text-muted">
                  <th className="text-left py-1 px-2">Apertura</th>
                  <th className="text-left py-1 px-2">Dir</th>
                  <th className="text-right py-1 px-2">Entry</th>
                  <th className="text-right py-1 px-2">Exit</th>
                  <th className="text-right py-1 px-2">R</th>
                  <th className="text-right py-1 px-2">€</th>
                  <th className="text-right py-1 px-2">€ Bal</th>
                  <th className="text-left py-1 px-2">Out</th>
                </tr>
              </thead>
              <tbody>
                {(Array.isArray(account?.trades) ? account.trades : []).slice(-15).reverse().map((t, i) => {
                  // Fix #5.11: defensive — server può inviare campi numerici null
                  const pnl = Number(t?.pnlEUR ?? 0)
                  const c = pnl >= 0 ? '#00e096' : '#ff3355'
                  const dirC = t?.direction === 'long' ? '#00e096' : '#ff3355'
                  const time = Number(t?.time)
                  const entry = Number(t?.entry)
                  const exitPrice = Number(t?.exitPrice)
                  const netRR = Number(t?.netRR ?? 0)
                  const balanceAfter = Number(t?.balanceAfter ?? 0)
                  return (
                    <tr key={i} className="border-b border-bg-border/30">
                      <td className="py-1 px-2 text-text-muted">
                        {Number.isFinite(time) ? new Date(time * 1000).toLocaleString('it-IT', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }) : '—'}
                      </td>
                      <td className="py-1 px-2 font-semibold" style={{ color: dirC }}>
                        {t?.direction === 'long' ? '▲' : t?.direction === 'short' ? '▼' : '—'}
                      </td>
                      <td className="py-1 px-2 text-right tabular-nums">{Number.isFinite(entry) ? entry.toFixed(entry < 10 ? 5 : 2) : '—'}</td>
                      <td className="py-1 px-2 text-right tabular-nums">{Number.isFinite(exitPrice) ? exitPrice.toFixed(exitPrice < 10 ? 5 : 2) : '—'}</td>
                      <td className="py-1 px-2 text-right tabular-nums" style={{ color: c }}>{netRR.toFixed(2)}</td>
                      <td className="py-1 px-2 text-right tabular-nums font-semibold" style={{ color: c }}>
                        {pnl >= 0 ? '+' : ''}€{pnl.toFixed(2)}
                      </td>
                      <td className="py-1 px-2 text-right tabular-nums">€{balanceAfter.toFixed(2)}</td>
                      <td className="py-1 px-2 text-text-muted text-xxs uppercase">{t?.outcome ?? '—'}</td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  )
}

// ─── StatCard ───────────────────────────────────────────────────────
function StatCard({ label, value, color = '#e5e7eb', sub }) {
  return (
    <div className="bg-bg-secondary rounded-md border border-bg-border p-3">
      <div className="font-mono text-xxs text-text-muted uppercase tracking-wider">{label}</div>
      <div className="font-mono text-xl tabular-nums font-semibold mt-0.5" style={{ color }}>{value}</div>
      {sub && <div className="font-mono text-xxs text-text-muted mt-0.5">{sub}</div>}
    </div>
  )
}
