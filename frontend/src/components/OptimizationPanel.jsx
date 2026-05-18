import { useState, useMemo } from 'react'
import { useAppStore } from '../store/store'
import { runOptimization, analyzeParameterSignificance, OPTIMIZATION_PRESETS } from '../services/ParameterOptimizer'

const SIG_COLOR = {
  high:   { bg: '#00e09618', text: '#00e096', label: 'ALTA' },
  medium: { bg: '#f5c84218', text: '#f5c842', label: 'MEDIA' },
  low:    { bg: '#8892a418', text: '#8892a4', label: 'BASSA' },
}

export default function OptimizationPanel() {
  const setPanel         = useAppStore(s => s.setActivePanel)
  const activeInstrument = useAppStore(s => s.activeInstrument)
  const activeTimeframe  = useAppStore(s => s.activeTimeframe)
  const candles          = useAppStore(s => s.instruments[activeInstrument]?.candles ?? [])

  const [preset, setPreset] = useState('quick')
  const [running, setRunning] = useState(false)
  const [progress, setProgress] = useState({ current: 0, total: 0 })
  const [results, setResults] = useState([])
  const [sortKey, setSortKey] = useState('profitFactor')
  const [sortDir, setSortDir] = useState('desc')

  const insights = useMemo(() => analyzeParameterSignificance(results), [results])

  const totalCombinations = useMemo(() => {
    const ranges = OPTIMIZATION_PRESETS[preset].ranges
    return Object.values(ranges).reduce((acc, arr) => acc * arr.length, 1)
  }, [preset])

  const handleRun = async () => {
    if (candles.length < 100) return
    setRunning(true)
    setResults([])
    setProgress({ current: 0, total: totalCombinations })
    try {
      const r = await runOptimization(candles, OPTIMIZATION_PRESETS[preset].ranges, (cur, tot) => {
        setProgress({ current: cur, total: tot })
      })
      setResults(r)
    } finally {
      setRunning(false)
    }
  }

  const sortedResults = useMemo(() => {
    return [...results].sort((a, b) => {
      let av = a[sortKey], bv = b[sortKey]
      if (av === Infinity) av = 999
      if (bv === Infinity) bv = 999
      return sortDir === 'desc' ? (bv - av) : (av - bv)
    })
  }, [results, sortKey, sortDir])

  const toggleSort = (key) => {
    if (sortKey === key) setSortDir(d => d === 'desc' ? 'asc' : 'desc')
    else { setSortKey(key); setSortDir('desc') }
  }

  return (
    <div className="h-full flex flex-col bg-bg-primary overflow-hidden">

      <div className="flex items-center justify-between px-6 py-4 border-b border-bg-border bg-bg-secondary shrink-0">
        <div>
          <h2 className="font-mono text-xl font-semibold text-gold tracking-wider">
            🎛 OPTIMIZER — {activeInstrument} {activeTimeframe}
          </h2>
          <p className="font-mono text-sm text-text-secondary mt-0.5">
            Grid search dei parametri di backtest. Cluster analysis stile Pythagorian: top vs bottom 20%.
          </p>
        </div>
        <button onClick={() => setPanel('chart')}
                className="font-mono text-sm text-text-secondary hover:text-text-primary px-4 py-2 hover:bg-bg-hover rounded-md border border-bg-border">
          ✕ Chiudi
        </button>
      </div>

      <div className="flex-1 overflow-y-auto p-6 space-y-5">

        {/* Setup ottimizzazione */}
        <div className="bg-bg-secondary rounded-xl border border-bg-border p-5">
          <div className="font-mono text-base font-semibold text-gold tracking-wider mb-3">
            CONFIGURAZIONE
          </div>

          <div className="flex items-center gap-4 mb-4">
            {Object.entries(OPTIMIZATION_PRESETS).map(([key, p]) => (
              <button key={key}
                onClick={() => setPreset(key)}
                disabled={running}
                className={`flex-1 px-4 py-3 rounded-md border-2 transition-all ${
                  preset === key
                    ? 'bg-gold/15 text-gold border-gold/50'
                    : 'border-bg-border text-text-secondary hover:bg-bg-hover'
                } disabled:opacity-50`}>
                <div className="font-mono text-sm font-semibold">{p.label}</div>
                <div className="font-mono text-xxs text-text-muted mt-1">{p.description}</div>
              </button>
            ))}
          </div>

          <div className="flex items-center justify-between">
            <div className="font-mono text-sm">
              <span className="text-text-muted">Combinazioni totali: </span>
              <span className="text-gold font-bold tabular-nums">{totalCombinations}</span>
              <span className="text-text-muted ml-3">Candele disponibili: </span>
              <span className="text-text-primary tabular-nums">{candles.length}</span>
            </div>
            <button onClick={handleRun}
                    disabled={running || candles.length < 100}
                    className="px-5 py-2.5 rounded-md font-mono text-sm font-medium bg-gold/20 text-gold border border-gold/50 hover:bg-gold/30 disabled:opacity-50 disabled:cursor-not-allowed">
              {running ? `⏳ ${progress.current}/${progress.total}` : '▶ Avvia ottimizzazione'}
            </button>
          </div>

          {running && (
            <div className="mt-3 h-2 bg-bg-primary rounded-full overflow-hidden">
              <div className="h-full bg-gold transition-all"
                   style={{ width: `${(progress.current / progress.total) * 100}%` }} />
            </div>
          )}
        </div>

        {/* Cluster analysis */}
        {insights.length > 0 && (
          <div className="bg-bg-secondary rounded-xl border border-bg-border p-5">
            <div className="font-mono text-base font-semibold text-gold tracking-wider mb-3">
              📊 CLUSTER ANALYSIS — Significatività parametri
            </div>
            <div className="space-y-2">
              {insights.map(ins => {
                const sig = SIG_COLOR[ins.significance]
                return (
                  <div key={ins.param} className="grid grid-cols-[120px_1fr_100px] gap-3 items-center
                                                   px-3 py-2 bg-bg-primary rounded-md border border-bg-border">
                    <span className="font-mono text-sm font-semibold text-gold">{ins.param}</span>
                    <span className="font-mono text-xs text-text-secondary">{ins.conclusion}</span>
                    <span className="px-2 py-0.5 rounded text-xxs font-mono font-semibold uppercase tracking-wider text-center"
                          style={{ backgroundColor: sig.bg, color: sig.text }}>
                      {sig.label}
                    </span>
                  </div>
                )
              })}
            </div>
          </div>
        )}

        {/* Tabella risultati */}
        {results.length > 0 && (
          <div className="bg-bg-secondary rounded-xl border border-bg-border overflow-hidden">
            <div className="px-5 py-3 border-b border-bg-border flex items-center justify-between">
              <span className="font-mono text-base font-semibold text-gold tracking-wider">
                📋 RISULTATI ({results.length} backtest)
              </span>
              <span className="font-mono text-xxs text-text-muted">
                Click sull'header per ordinare. Trascina la barra a destra per scrollare.
              </span>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full font-mono text-xs">
                <thead className="bg-bg-primary sticky top-0">
                  <tr className="text-text-muted">
                    <th className="text-left px-3 py-2">#</th>
                    <SortHeader label="ATR" k="atrPeriod" sortKey={sortKey} sortDir={sortDir} onClick={(k) => toggleSort(`params.${k}`)}
                                accessor={(r) => r.params.atrPeriod} />
                    <SortHeader label="SL×ATR" k="slMultiplier" sortKey={sortKey} sortDir={sortDir} onClick={(k) => toggleSort(`params.${k}`)} />
                    <SortHeader label="TP×ATR" k="tpMultiplier" sortKey={sortKey} sortDir={sortDir} onClick={(k) => toggleSort(`params.${k}`)} />
                    <SortHeader label="MaxBars" k="maxBars" sortKey={sortKey} sortDir={sortDir} onClick={(k) => toggleSort(`params.${k}`)} />
                    <SortHeader label="Trades" k="total" sortKey={sortKey} sortDir={sortDir} onClick={toggleSort} align="right" />
                    <SortHeader label="Win Rate" k="winRate" sortKey={sortKey} sortDir={sortDir} onClick={toggleSort} align="right" />
                    <SortHeader label="Profit Factor" k="profitFactor" sortKey={sortKey} sortDir={sortDir} onClick={toggleSort} align="right" />
                    <SortHeader label="R:R" k="avgRR" sortKey={sortKey} sortDir={sortDir} onClick={toggleSort} align="right" />
                    <SortHeader label="Max DD" k="maxDD" sortKey={sortKey} sortDir={sortDir} onClick={toggleSort} align="right" />
                    <SortHeader label="Sharpe" k="sharpe" sortKey={sortKey} sortDir={sortDir} onClick={toggleSort} align="right" />
                    <SortHeader label="Expectancy" k="expectancy" sortKey={sortKey} sortDir={sortDir} onClick={toggleSort} align="right" />
                  </tr>
                </thead>
                <tbody>
                  {sortedResults.slice(0, 50).map((r, i) => {
                    const isTop = i < 5
                    const isBot = i >= sortedResults.length - 5 && sortedResults.length > 10
                    return (
                      <tr key={i} className={`border-b border-bg-border/40 hover:bg-bg-hover ${
                        isTop ? 'bg-green/5' : isBot ? 'bg-red/5' : ''}`}>
                        <td className="px-3 py-1.5 text-text-muted">{i + 1}</td>
                        <td className="px-3 py-1.5 tabular-nums">{r.params.atrPeriod}</td>
                        <td className="px-3 py-1.5 tabular-nums">{r.params.slMultiplier}</td>
                        <td className="px-3 py-1.5 tabular-nums">{r.params.tpMultiplier}</td>
                        <td className="px-3 py-1.5 tabular-nums">{r.params.maxBars}</td>
                        <td className="px-3 py-1.5 text-right tabular-nums">{r.total}</td>
                        <td className="px-3 py-1.5 text-right tabular-nums"
                            style={{ color: r.winRate >= 0.55 ? '#00e096' : r.winRate < 0.45 ? '#ff3355' : '#f5c842' }}>
                          {(r.winRate * 100).toFixed(0)}%
                        </td>
                        <td className="px-3 py-1.5 text-right tabular-nums font-semibold"
                            style={{ color: r.profitFactor >= 1.5 ? '#00e096' : r.profitFactor < 1 ? '#ff3355' : '#f5c842' }}>
                          {isFinite(r.profitFactor) ? r.profitFactor.toFixed(2) : '∞'}
                        </td>
                        <td className="px-3 py-1.5 text-right tabular-nums"
                            style={{ color: r.avgRR > 0 ? '#00e096' : '#ff3355' }}>
                          {r.avgRR.toFixed(2)}
                        </td>
                        <td className="px-3 py-1.5 text-right tabular-nums text-red/70">{r.maxDD.toFixed(1)}R</td>
                        <td className="px-3 py-1.5 text-right tabular-nums"
                            style={{ color: r.sharpe >= 1 ? '#00e096' : r.sharpe < 0.5 ? '#ff3355' : '#f5c842' }}>
                          {r.sharpe?.toFixed(2) || '—'}
                        </td>
                        <td className="px-3 py-1.5 text-right tabular-nums">{r.expectancy?.toFixed(3) || '—'}</td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
              {sortedResults.length > 50 && (
                <div className="px-5 py-2 text-center font-mono text-xxs text-text-muted">
                  Mostrati i primi 50 di {sortedResults.length}. Cambia ordinamento per vedere altri.
                </div>
              )}
            </div>
          </div>
        )}

        {results.length === 0 && !running && (
          <div className="text-center py-12 font-mono text-sm text-text-muted">
            {candles.length < 100
              ? `Servono almeno 100 candele (attuali: ${candles.length}). Apri uno strumento per popolare i dati.`
              : 'Nessun risultato. Premi "Avvia ottimizzazione" per iniziare.'}
          </div>
        )}
      </div>
    </div>
  )
}

function SortHeader({ label, k, sortKey, sortDir, onClick, align = 'left' }) {
  const active = sortKey === k
  return (
    <th onClick={() => onClick(k)}
        className={`px-3 py-2 cursor-pointer hover:text-gold uppercase tracking-wider text-xxs whitespace-nowrap ${
          align === 'right' ? 'text-right' : 'text-left'
        } ${active ? 'text-gold' : ''}`}>
      {label} {active && (sortDir === 'desc' ? '↓' : '↑')}
    </th>
  )
}
