import { useState } from 'react'
import { useAppStore } from '../store/store'
import { SCALPING_STRATEGIES, SCALP_PAIRS, isStrategyCompatibleWithPair } from '../services/ScalpingLibrary'
import { runScalpStrategyAcrossPairs } from '../services/ScalpingBacktest'
import { loadHistoricalCandles, clearHistoricalCache } from '../services/HistoricalLoader'
import { listBrokers } from '../services/TradingCosts'
import { useToast } from './ui/Toast'

const TIMEFRAMES = ['5m', '15m', '1h']
const PERIOD_OPTIONS = [
  { months: 1,  label: '1 mese',   estCalls: 1 },
  { months: 3,  label: '3 mesi',   estCalls: 1 },
  { months: 6,  label: '6 mesi',   estCalls: 2 },
  { months: 12, label: '1 anno',   estCalls: 4 },
]

export default function ScalpingPanel() {
  const apiKeys = useAppStore(s => s.apiKeys)
  const setPanel = useAppStore(s => s.setActivePanel)

  const [selectedPairs, setSelectedPairs] = useState(SCALP_PAIRS.map(p => p.id))
  const [selectedStrategies, setSelectedStrategies] = useState(SCALPING_STRATEGIES.map(s => s.id))
  const [timeframe, setTimeframe] = useState('15m')
  const [periodMonths, setPeriodMonths] = useState(3)
  const [brokerId, setBrokerId] = useState('fpmarkets_raw')
  const [running, setRunning] = useState(false)
  const [progress, setProgress] = useState('')
  const [results, setResults]   = useState(null)
  const [error, setError]       = useState(null)
  const [viewMode, setViewMode] = useState('matrix')   // 'matrix' | 'best-per-pair' | 'best-per-strategy'
  const toast = useToast()

  const togglePair = (id) => {
    setSelectedPairs(p => p.includes(id) ? p.filter(x => x !== id) : [...p, id])
  }
  const toggleStrategy = (id) => {
    setSelectedStrategies(s => s.includes(id) ? s.filter(x => x !== id) : [...s, id])
  }

  const handleRun = async () => {
    if (selectedPairs.length === 0)      { setError('Seleziona almeno un asset'); return }
    if (selectedStrategies.length === 0) { setError('Seleziona almeno una strategia'); return }
    setRunning(true); setError(null); setResults(null)

    const candlesByPair = {}
    const yearsEquiv = periodMonths / 12
    try {
      // 1. Carica candele per ogni pair selezionato
      for (const pair of selectedPairs) {
        setProgress(`Carico ${pair} ${timeframe} (${periodMonths}m)...`)
        try {
          const { candles } = await loadHistoricalCandles(pair, timeframe, yearsEquiv, apiKeys.twelvedata,
                                                          msg => setProgress(`${pair}: ${msg}`))
          candlesByPair[pair] = candles
        } catch (err) {
          console.warn(`[Scalp] ${pair} fallito:`, err.message)
          candlesByPair[pair] = []
        }
      }

      // 2. Run ogni strategia su ogni pair
      const grid = {}    // grid[strategyId][pairId] = result
      let i = 0
      const total = selectedStrategies.length
      for (const stratId of selectedStrategies) {
        i++
        const strat = SCALPING_STRATEGIES.find(s => s.id === stratId)
        if (!strat) continue
        setProgress(`Backtest ${i}/${total}: ${strat.name}...`)
        // Filtra pair compatibili
        const filteredCandles = {}
        for (const [pair, candles] of Object.entries(candlesByPair)) {
          if (isStrategyCompatibleWithPair(strat, pair)) {
            filteredCandles[pair] = candles
          }
        }
        grid[stratId] = runScalpStrategyAcrossPairs(strat, filteredCandles, { brokerId })
        // Yield event loop ogni strategia per UI fluida
        await new Promise(r => setTimeout(r, 0))
      }

      setResults({ grid, candleCount: Object.fromEntries(
        Object.entries(candlesByPair).map(([k, v]) => [k, v.length])
      ) })
      setProgress('')
      toast.success(`Backtest completato: ${total} strategie × ${selectedPairs.length} asset`,
                    { title: '⚡ Scalping' })
    } catch (err) {
      setError(err.message)
      toast.error(err.message, { title: 'Errore Scalp Backtest', duration: 6000 })
    } finally {
      setRunning(false)
    }
  }

  return (
    <div className="h-full flex flex-col bg-bg-primary overflow-hidden">

      {/* Header */}
      <div className="flex items-center justify-between px-6 py-3 border-b border-bg-border bg-bg-secondary shrink-0">
        <div>
          <h2 className="font-mono text-lg font-semibold text-gold tracking-wider">⚡ SCALPING LAB</h2>
          <p className="font-mono text-xs text-text-muted mt-0.5">
            {SCALPING_STRATEGIES.length} strategie scalp · {SCALP_PAIRS.length} asset · separato dal trading swing
          </p>
        </div>
        <button onClick={() => setPanel('chart')}
                className="font-mono text-sm text-text-secondary hover:text-text-primary px-3 py-1.5 hover:bg-bg-hover rounded-md border border-bg-border">
          ✕ Chiudi
        </button>
      </div>

      {/* Body */}
      <div className="flex-1 overflow-y-auto p-5">

        {/* Config */}
        <div className="bg-bg-secondary rounded-xl border border-bg-border p-4 mb-4">
          <div className="grid grid-cols-1 md:grid-cols-4 gap-3 mb-4">
            <div>
              <label className="font-mono text-xxs text-text-muted uppercase tracking-wider block mb-1">Timeframe</label>
              <select value={timeframe} onChange={e => setTimeframe(e.target.value)}
                      className="w-full bg-bg-primary border border-bg-border rounded-md px-2 py-1 font-mono text-xs text-text-primary">
                {TIMEFRAMES.map(tf => <option key={tf} value={tf}>{tf}</option>)}
              </select>
            </div>
            <div>
              <label className="font-mono text-xxs text-text-muted uppercase tracking-wider block mb-1">Periodo</label>
              <select value={periodMonths} onChange={e => setPeriodMonths(Number(e.target.value))}
                      className="w-full bg-bg-primary border border-bg-border rounded-md px-2 py-1 font-mono text-xs text-text-primary">
                {PERIOD_OPTIONS.map(p => <option key={p.months} value={p.months}>{p.label}</option>)}
              </select>
            </div>
            <div>
              <label className="font-mono text-xxs text-text-muted uppercase tracking-wider block mb-1">Broker (costi)</label>
              <select value={brokerId} onChange={e => setBrokerId(e.target.value)}
                      className="w-full bg-bg-primary border border-bg-border rounded-md px-2 py-1 font-mono text-xs text-text-primary">
                {listBrokers().map(b => <option key={b.id} value={b.id}>{b.label}</option>)}
              </select>
            </div>
            <div className="flex items-end gap-2">
              <button onClick={handleRun} disabled={running}
                      className="flex-1 px-4 py-1.5 rounded-md font-mono text-sm font-semibold bg-gold/20 text-gold border border-gold/50 hover:bg-gold/30 disabled:opacity-50">
                {running ? '⏳ In corso...' : `▶ Run`}
              </button>
              <button onClick={() => { clearHistoricalCache(); toast.success('Cache svuotata') }}
                      className="px-2 py-1 font-mono text-xxs text-text-muted hover:text-text-primary">
                🔥
              </button>
            </div>
          </div>

          {/* Pair selector */}
          <div className="mb-3">
            <div className="flex items-center justify-between mb-1">
              <span className="font-mono text-xxs text-text-muted uppercase tracking-wider">Asset ({selectedPairs.length}/{SCALP_PAIRS.length})</span>
              <div className="flex gap-2">
                <button onClick={() => setSelectedPairs(SCALP_PAIRS.map(p => p.id))}
                        className="font-mono text-xxs text-text-secondary hover:text-text-primary">tutti</button>
                <button onClick={() => setSelectedPairs([])}
                        className="font-mono text-xxs text-text-secondary hover:text-text-primary">nessuno</button>
              </div>
            </div>
            <div className="flex flex-wrap gap-1.5">
              {SCALP_PAIRS.map(p => {
                const active = selectedPairs.includes(p.id)
                const catColor = p.category === 'crypto' ? '#f5c842' : p.category === 'commodity' ? '#cc785c' : '#7be0a3'
                return (
                  <button key={p.id} onClick={() => togglePair(p.id)}
                          className={`px-2.5 py-1 rounded font-mono text-xxs transition-all ${
                            active ? 'bg-gold/20 text-gold border border-gold/40' : 'bg-bg-primary text-text-secondary border border-bg-border hover:bg-bg-hover'
                          }`}>
                    <span className="mr-1" style={{ color: active ? undefined : catColor }}>●</span>
                    {p.id}
                  </button>
                )
              })}
            </div>
          </div>

          {/* Strategy selector */}
          <div>
            <div className="flex items-center justify-between mb-1">
              <span className="font-mono text-xxs text-text-muted uppercase tracking-wider">Strategie ({selectedStrategies.length}/{SCALPING_STRATEGIES.length})</span>
              <div className="flex gap-2">
                <button onClick={() => setSelectedStrategies(SCALPING_STRATEGIES.map(s => s.id))}
                        className="font-mono text-xxs text-text-secondary hover:text-text-primary">tutte</button>
                <button onClick={() => setSelectedStrategies([])}
                        className="font-mono text-xxs text-text-secondary hover:text-text-primary">nessuna</button>
              </div>
            </div>
            <div className="flex flex-wrap gap-1.5">
              {SCALPING_STRATEGIES.map(s => {
                const active = selectedStrategies.includes(s.id)
                return (
                  <button key={s.id} onClick={() => toggleStrategy(s.id)}
                          title={`${s.desc} · WR atteso: ${s.expectedWR}`}
                          className={`px-2.5 py-1 rounded font-mono text-xxs transition-all flex items-center gap-1 ${
                            active ? 'bg-gold/20 text-gold border border-gold/40' : 'bg-bg-primary text-text-secondary border border-bg-border hover:bg-bg-hover'
                          }`}>
                    <span>{s.icon}</span>
                    <span>{s.name}</span>
                    <span className="text-text-muted">{s.expectedWR}</span>
                  </button>
                )
              })}
            </div>
          </div>

          {progress && (
            <div className="mt-3 font-mono text-xs text-text-secondary bg-bg-primary rounded-md px-3 py-2">{progress}</div>
          )}
          {error && (
            <div className="mt-3 font-mono text-xs text-red bg-red/10 border border-red/30 rounded-md px-3 py-2">⚠ {error}</div>
          )}
        </div>

        {/* Strategy cards (visibili sempre) */}
        {!results && (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
            {SCALPING_STRATEGIES.map(s => (
              <div key={s.id} className="bg-bg-secondary rounded-md border border-bg-border p-3">
                <div className="flex items-center gap-2 mb-1">
                  <span className="text-base text-gold">{s.icon}</span>
                  <span className="font-mono text-sm font-semibold text-text-primary flex-1">{s.name}</span>
                  <span className="font-mono text-xxs text-gold">{s.expectedWR}</span>
                </div>
                <div className="flex gap-1 mb-2 font-mono text-xxs">
                  <span className="px-1.5 py-0.5 rounded bg-bg-primary text-text-muted">{s.style}</span>
                  <span className="px-1.5 py-0.5 rounded bg-bg-primary text-text-muted">SL {s.slMul}× / TP {s.tpMul}×</span>
                  <span className="px-1.5 py-0.5 rounded bg-bg-primary text-text-muted">{s.optimalTF.join('/')}</span>
                </div>
                <div className="font-mono text-xxs text-text-secondary leading-relaxed">{s.desc}</div>
              </div>
            ))}
          </div>
        )}

        {/* Results */}
        {results && (
          <ResultsView results={results} viewMode={viewMode} setViewMode={setViewMode} selectedPairs={selectedPairs} />
        )}
      </div>
    </div>
  )
}

// ─── Results: matrix / best-per-pair / best-per-strategy ────────────
function ResultsView({ results, viewMode, setViewMode, selectedPairs }) {
  return (
    <div>
      {/* View toggle */}
      <div className="flex items-center justify-between mb-3 flex-wrap gap-2">
        <div className="flex gap-1 bg-bg-primary border border-bg-border rounded-md p-0.5">
          {[
            { id: 'matrix', label: 'Matrix completa' },
            { id: 'best-per-pair', label: 'Best per asset' },
            { id: 'best-per-strategy', label: 'Best per strategia' },
          ].map(v => (
            <button key={v.id} onClick={() => setViewMode(v.id)}
                    className={`px-3 py-1 rounded font-mono text-xs ${viewMode === v.id ? 'bg-gold/20 text-gold' : 'text-text-secondary hover:text-text-primary'}`}>
              {v.label}
            </button>
          ))}
        </div>
        <div className="font-mono text-xxs text-text-muted">
          Candele caricate: {Object.entries(results.candleCount).map(([k, v]) => `${k}: ${v}`).join(' · ')}
        </div>
      </div>

      {viewMode === 'matrix'             && <MatrixView grid={results.grid} pairs={selectedPairs} />}
      {viewMode === 'best-per-pair'      && <BestPerPairView grid={results.grid} pairs={selectedPairs} />}
      {viewMode === 'best-per-strategy'  && <BestPerStrategyView grid={results.grid} pairs={selectedPairs} />}
    </div>
  )
}

// Matrix completa: righe = strategie, colonne = pair, cella = WR/PF/Trade
function MatrixView({ grid, pairs }) {
  const stratIds = Object.keys(grid)
  return (
    <div className="bg-bg-secondary rounded-xl border border-bg-border overflow-x-auto">
      <table className="w-full font-mono text-xs">
        <thead>
          <tr className="text-text-muted bg-bg-primary/50 border-b border-bg-border">
            <th className="text-left py-2 px-3 sticky left-0 bg-bg-primary z-10">Strategia</th>
            {pairs.map(p => (
              <th key={p} className="text-right py-2 px-3 min-w-[110px]">{p}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {stratIds.map(sid => {
            const strat = SCALPING_STRATEGIES.find(s => s.id === sid)
            return (
              <tr key={sid} className="border-b border-bg-border/50 hover:bg-bg-hover">
                <td className="py-2 px-3 sticky left-0 bg-bg-secondary z-10">
                  <div className="flex items-center gap-1.5">
                    <span>{strat?.icon}</span>
                    <span className="font-semibold text-text-primary text-xs">{strat?.name}</span>
                  </div>
                  <div className="text-xxs text-text-muted">{strat?.style} · {strat?.expectedWR}</div>
                </td>
                {pairs.map(p => {
                  const r = grid[sid]?.[p]
                  return <MatrixCell key={p} result={r} />
                })}
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

function MatrixCell({ result }) {
  if (!result || !result.summary || result.summary.total === 0) {
    return <td className="py-2 px-3 text-right text-text-muted text-xxs">—</td>
  }
  const s = result.summary
  const wrColor = s.winRate >= 0.55 ? '#00e096' : s.winRate < 0.45 ? '#ff3355' : '#f5c842'
  const pfColor = s.profitFactor >= 1.3 ? '#00e096' : s.profitFactor < 1 ? '#ff3355' : '#f5c842'
  const sigColor = s.significance?.color || '#8892a4'
  return (
    <td className="py-1.5 px-3 text-right tabular-nums">
      <div className="font-semibold" style={{ color: wrColor }}>
        {(s.winRate * 100).toFixed(0)}%
      </div>
      <div className="text-xxs" style={{ color: pfColor }}>
        PF {isFinite(s.profitFactor) ? s.profitFactor.toFixed(2) : '∞'}
      </div>
      <div className="text-xxs text-text-muted">
        {s.total} · <span style={{ color: sigColor }}>{'★'.repeat(s.significance?.stars || 0)}</span>
      </div>
    </td>
  )
}

// Best 3 strategie per ogni asset
function BestPerPairView({ grid, pairs }) {
  const stratIds = Object.keys(grid)
  return (
    <div className="space-y-4">
      {pairs.map(pair => {
        const ranked = stratIds
          .map(sid => ({
            strategy: SCALPING_STRATEGIES.find(s => s.id === sid),
            result: grid[sid]?.[pair],
          }))
          .filter(x => x.result?.summary?.total >= 10)
          .sort((a, b) => (b.result.summary.profitFactor || 0) - (a.result.summary.profitFactor || 0))
          .slice(0, 5)

        if (ranked.length === 0) return (
          <div key={pair} className="bg-bg-secondary rounded-xl border border-bg-border p-4">
            <span className="font-mono text-base font-semibold text-gold">{pair}</span>
            <span className="font-mono text-xxs text-text-muted ml-3">Nessuna strategia con sample sufficiente</span>
          </div>
        )

        return (
          <div key={pair} className="bg-bg-secondary rounded-xl border border-bg-border overflow-hidden">
            <div className="px-5 py-2 border-b border-bg-border bg-bg-primary/50">
              <span className="font-mono text-base font-semibold text-gold">{pair}</span>
              <span className="font-mono text-xxs text-text-muted ml-3">Top 5 strategie</span>
            </div>
            <ResultsTable rows={ranked.map(r => ({ ...r, label: r.strategy.name, icon: r.strategy.icon }))} />
          </div>
        )
      })}
    </div>
  )
}

// Best 3 asset per ogni strategia
function BestPerStrategyView({ grid, pairs }) {
  const stratIds = Object.keys(grid)
  return (
    <div className="space-y-4">
      {stratIds.map(sid => {
        const strat = SCALPING_STRATEGIES.find(s => s.id === sid)
        const ranked = pairs
          .map(p => ({
            pair: p,
            result: grid[sid]?.[p],
          }))
          .filter(x => x.result?.summary?.total >= 10)
          .sort((a, b) => (b.result.summary.profitFactor || 0) - (a.result.summary.profitFactor || 0))
          .slice(0, 5)

        if (ranked.length === 0) return null

        return (
          <div key={sid} className="bg-bg-secondary rounded-xl border border-bg-border overflow-hidden">
            <div className="px-5 py-2 border-b border-bg-border bg-bg-primary/50">
              <span className="text-base mr-2">{strat?.icon}</span>
              <span className="font-mono text-base font-semibold text-gold">{strat?.name}</span>
              <span className="font-mono text-xxs text-text-muted ml-3">{strat?.style} · WR atteso {strat?.expectedWR} · SL {strat?.slMul}× / TP {strat?.tpMul}×</span>
            </div>
            <ResultsTable rows={ranked.map(r => ({ ...r, label: r.pair, icon: '' }))} />
          </div>
        )
      })}
    </div>
  )
}

function ResultsTable({ rows }) {
  return (
    <table className="w-full font-mono text-xs">
      <thead>
        <tr className="text-text-muted bg-bg-primary/30 border-b border-bg-border">
          <th className="text-left py-1.5 px-3">#</th>
          <th className="text-left py-1.5 px-3"></th>
          <th className="text-right py-1.5 px-3">Trade</th>
          <th className="text-right py-1.5 px-3" title="Trade per giorno">/day</th>
          <th className="text-right py-1.5 px-3">WR</th>
          <th className="text-right py-1.5 px-3" title="Win rate raw senza costi">WR raw</th>
          <th className="text-right py-1.5 px-3" title="Costo medio per trade in R">Costo</th>
          <th className="text-right py-1.5 px-3">R medio</th>
          <th className="text-right py-1.5 px-3">PF</th>
          <th className="text-right py-1.5 px-3">DD</th>
          <th className="text-right py-1.5 px-3">Equity</th>
          <th className="text-left  py-1.5 px-3">Affid.</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((row, i) => {
          const s = row.result.summary
          const wrColor = s.winRate >= 0.55 ? '#00e096' : s.winRate < 0.45 ? '#ff3355' : '#f5c842'
          const pfColor = s.profitFactor >= 1.3 ? '#00e096' : s.profitFactor < 1 ? '#ff3355' : '#f5c842'
          const eqColor = s.finalEquity >= 0 ? '#00e096' : '#ff3355'
          return (
            <tr key={i} className={`border-b border-bg-border/50 hover:bg-bg-hover ${i === 0 ? 'bg-gold/5' : ''}`}>
              <td className="py-2 px-3 text-text-muted tabular-nums">{i + 1}</td>
              <td className="py-2 px-3 text-text-primary font-semibold">{row.icon} {row.label}</td>
              <td className="py-2 px-3 text-right tabular-nums">{s.total}</td>
              <td className="py-2 px-3 text-right tabular-nums text-text-muted">{(s.tradesPerDay || 0).toFixed(1)}</td>
              <td className="py-2 px-3 text-right tabular-nums font-semibold" style={{ color: wrColor }}>{(s.winRate * 100).toFixed(0)}%</td>
              <td className="py-2 px-3 text-right tabular-nums text-text-muted">{((s.winRateRaw || 0) * 100).toFixed(0)}%</td>
              <td className="py-2 px-3 text-right tabular-nums text-text-muted text-xxs">-{(s.avgCost || 0).toFixed(3)}R</td>
              <td className="py-2 px-3 text-right tabular-nums">{s.avgRR.toFixed(2)}</td>
              <td className="py-2 px-3 text-right tabular-nums font-semibold" style={{ color: pfColor }}>
                {isFinite(s.profitFactor) ? s.profitFactor.toFixed(2) : '∞'}
              </td>
              <td className="py-2 px-3 text-right tabular-nums text-red/70">{s.maxDD.toFixed(1)}R</td>
              <td className="py-2 px-3 text-right tabular-nums font-semibold" style={{ color: eqColor }}>
                {s.finalEquity >= 0 ? '+' : ''}{s.finalEquity.toFixed(1)}R
              </td>
              <td className="py-2 px-3">
                {s.significance && (
                  <span className="font-mono text-xxs" style={{ color: s.significance.color }}>
                    {'★'.repeat(s.significance.stars)}{'☆'.repeat(4 - s.significance.stars)}
                  </span>
                )}
              </td>
            </tr>
          )
        })}
      </tbody>
    </table>
  )
}
