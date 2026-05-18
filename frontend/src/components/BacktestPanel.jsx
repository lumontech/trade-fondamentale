import { useMemo, useState } from 'react'
import { useAppStore } from '../store/store'
import { runBacktest } from '../services/BacktestEngine'
import { runPatternBacktest } from '../services/PatternBacktest'
import { runAllStrategies, STRATEGIES } from '../services/StrategyLibrary'
import { loadHistoricalCandles, clearHistoricalCache } from '../services/HistoricalLoader'
import { listBrokers } from '../services/TradingCosts'
import { useToast } from './ui/Toast'

const SIGNAL_LABELS = ['COMPRA FORTE', 'COMPRA', 'VENDI', 'VENDI FORTE']
const SIGNAL_COLOR = {
  'COMPRA FORTE': '#00e096',
  'COMPRA':       '#7be0a3',
  'VENDI':        '#ff7a8d',
  'VENDI FORTE':  '#ff3355',
}

const TABS = [
  { id: 'signals',  icon: '📊', label: 'Segnali',  desc: 'Backtest dei segnali tecnici aggregati' },
  { id: 'patterns', icon: '🎯', label: 'Pattern',  desc: 'Frequenza e performance pattern (candle/chart/armonici)' },
  { id: 'strategies', icon: '⚡', label: 'Strategie', desc: 'Backtest delle strategie classiche' },
]

const ANALYSIS_SYMBOLS = ['XAUUSD', 'BTCUSD']

// Configurazione condivisa tra i tab Pattern / Strategie
function useBacktestConfig() {
  const [brokerId, setBrokerId] = useState('fpmarkets_raw')
  const [years, setYears]       = useState(5)
  const [timeframe, setTimeframe] = useState('1D')
  return { brokerId, setBrokerId, years, setYears, timeframe, setTimeframe }
}

export default function BacktestPanel() {
  const instruments     = useAppStore(s => s.instruments)
  const activeTimeframe = useAppStore(s => s.activeTimeframe)
  const apiKeys         = useAppStore(s => s.apiKeys)
  const setPanel        = useAppStore(s => s.setActivePanel)
  const [tab, setTab]   = useState('signals')
  const cfg = useBacktestConfig()

  // Backtest segnali (live, sui dati attualmente caricati)
  const signalResults = useMemo(() => {
    const out = {}
    for (const [symbol, data] of Object.entries(instruments)) {
      if (!data.candles || data.candles.length < 100) continue
      out[symbol] = runBacktest(data.candles)
    }
    return out
  }, [instruments])

  return (
    <div className="h-full flex flex-col bg-bg-primary overflow-hidden">

      {/* Header + tabs */}
      <div className="border-b border-bg-border bg-bg-secondary shrink-0">
        <div className="flex items-center justify-between px-6 py-3">
          <div>
            <h2 className="font-mono text-lg font-semibold text-gold tracking-wider">📊 BACKTEST LAB</h2>
            <p className="font-mono text-xs text-text-muted mt-0.5">
              {tab === 'signals'    && `Segnali aggregati · TF ${activeTimeframe} · SL 1.5×ATR / TP 3×ATR`}
              {tab === 'patterns'   && `Pattern frequency · ${cfg.years}y · ${cfg.timeframe} · costi ${cfg.brokerId}`}
              {tab === 'strategies' && `Strategie classiche · ${cfg.years}y · ${cfg.timeframe} · costi ${cfg.brokerId}`}
            </p>
          </div>
          <button onClick={() => setPanel('chart')}
                  className="font-mono text-sm text-text-secondary hover:text-text-primary px-3 py-1.5 hover:bg-bg-hover rounded-md border border-bg-border">
            ✕ Chiudi
          </button>
        </div>
        <div className="flex border-t border-bg-border">
          {TABS.map(t => (
            <button key={t.id}
                    onClick={() => setTab(t.id)}
                    title={t.desc}
                    className={`flex-1 px-4 py-2.5 font-mono text-sm border-b-2 transition-all flex items-center justify-center gap-2 ${
                      tab === t.id
                        ? 'border-gold text-gold bg-bg-primary/30'
                        : 'border-transparent text-text-secondary hover:text-text-primary hover:bg-bg-hover'
                    }`}>
              <span>{t.icon}</span>
              <span>{t.label}</span>
            </button>
          ))}
        </div>
      </div>

      {/* Body */}
      <div className="flex-1 overflow-y-auto">
        {tab === 'signals'    && <SignalsTab results={signalResults} />}
        {tab === 'patterns'   && <PatternsTab apiKeys={apiKeys} cfg={cfg} />}
        {tab === 'strategies' && <StrategiesTab apiKeys={apiKeys} cfg={cfg} />}
      </div>
    </div>
  )
}

// ─── TAB 1: Segnali (esistente) ─────────────────────────────────────
function SignalsTab({ results }) {
  return (
    <div className="p-6 space-y-5">
      {Object.keys(results).length === 0 && (
        <div className="text-center py-20">
          <div className="font-mono text-base text-text-muted">⏳ Caricamento candele...</div>
          <div className="font-mono text-xs text-text-muted mt-2">
            Apri uno strumento dalla watchlist per popolare il backtest segnali.
          </div>
        </div>
      )}
      {Object.entries(results).map(([symbol, result]) => (
        <InstrumentResults key={symbol} symbol={symbol} result={result} />
      ))}
    </div>
  )
}

// ─── TAB 2: Pattern frequency ──────────────────────────────────────
function PatternsTab({ apiKeys, cfg }) {
  const [running, setRunning] = useState(false)
  const [progress, setProgress] = useState('')
  const [results, setResults] = useState(null)  // { XAUUSD: {...}, BTCUSD: {...} }
  const [error, setError]     = useState(null)
  const toast = useToast()

  const handleRun = async () => {
    setRunning(true)
    setError(null)
    setResults(null)
    const out = {}
    try {
      for (const symbol of ANALYSIS_SYMBOLS) {
        setProgress(`Carico ${symbol} ${cfg.years}y ${cfg.timeframe}...`)
        const { candles, fromCache } = await loadHistoricalCandles(
          symbol, cfg.timeframe, cfg.years, apiKeys.twelvedata,
          msg => setProgress(`${symbol}: ${msg}`)
        )
        setProgress(`Backtest pattern su ${symbol} (${candles.length} candele${fromCache ? ' · cache' : ''})...`)
        const res = runPatternBacktest(candles, {
          symbol,
          brokerId: cfg.brokerId,
          walkForward: true,
        }, pct => setProgress(`${symbol}: scansione ${pct}%`))
        out[symbol] = { ...res, candleCount: candles.length, fromCache }
      }
      setResults(out)
      setProgress('')
      toast.success(`Backtest pattern completato per ${Object.keys(out).join(', ')}`,
                    { title: '🎯 Pattern analysis' })
    } catch (err) {
      setError(err.message)
      toast.error(err.message, { title: 'Errore Pattern Backtest', duration: 6000 })
    } finally {
      setRunning(false)
    }
  }

  return (
    <div className="p-6 space-y-4">

      <div className="bg-bg-secondary rounded-xl border border-bg-border p-4">
        <div className="flex items-center justify-between gap-4 flex-wrap">
          <div className="flex-1 min-w-0">
            <div className="font-mono text-sm font-semibold text-gold mb-1">
              Pattern Frequency Analysis · {cfg.years} anni · {cfg.timeframe}
            </div>
            <div className="font-mono text-xs text-text-secondary leading-relaxed">
              Scorre la storia di <span className="text-gold">XAUUSD</span> e <span className="text-gold">BTCUSD</span>,
              individua ogni pattern (candlestick · chart · armonici) ed esegue un trade simulato
              <strong> con costi reali del broker selezionato</strong> (spread + slippage + commission).
              Output con flag di significatività statistica e split walk-forward 70/30.
            </div>
          </div>
          <div className="flex flex-col gap-2 shrink-0">
            <button onClick={handleRun} disabled={running}
                    className="px-5 py-2 rounded-md font-mono text-sm font-semibold bg-gold/20 text-gold border border-gold/50 hover:bg-gold/30 disabled:opacity-50 disabled:cursor-not-allowed">
              {running ? '⏳ In corso...' : '▶ Esegui backtest pattern'}
            </button>
            <button onClick={() => { clearHistoricalCache(); toast.success('Cache storica svuotata') }}
                    className="px-3 py-1 font-mono text-xxs text-text-secondary hover:text-text-primary">
              Svuota cache
            </button>
          </div>
        </div>

        <ConfigBar cfg={cfg} />

        {progress && (
          <div className="mt-3 font-mono text-xs text-text-secondary bg-bg-primary rounded-md px-3 py-2">
            {progress}
          </div>
        )}
        {error && (
          <div className="mt-3 font-mono text-xs text-red bg-red/10 border border-red/30 rounded-md px-3 py-2">
            ⚠ {error}
          </div>
        )}
        {!apiKeys.twelvedata && (
          <div className="mt-3 font-mono text-xxs text-text-muted">
            ⚙ XAUUSD richiede TwelveData API key (configurabile in API Hub). BTC funziona via Binance senza key.
          </div>
        )}
      </div>

      {results && (
        <div className="space-y-5">
          {ANALYSIS_SYMBOLS.map(symbol => {
            const r = results[symbol]
            if (!r || r.error) return (
              <div key={symbol} className="bg-bg-secondary rounded-xl border border-red/30 p-4">
                <span className="font-mono text-base text-gold font-semibold">{symbol}</span>
                <div className="font-mono text-xs text-red mt-2">{r?.error || 'Errore'}</div>
              </div>
            )
            return <PatternResults key={symbol} symbol={symbol} result={r} />
          })}
        </div>
      )}
    </div>
  )
}

function PatternResults({ symbol, result }) {
  const [view, setView] = useState('frequency')   // 'frequency' | 'performance' | 'category'

  const list = view === 'frequency'   ? result.byFrequency
             : view === 'performance' ? result.byPerformance
             : null  // category handled separately

  return (
    <div className="bg-bg-secondary rounded-xl border border-bg-border overflow-hidden">

      {/* Header */}
      <div className="px-5 py-3 border-b border-bg-border flex items-center justify-between flex-wrap gap-3">
        <div className="flex items-center gap-3">
          <span className="font-mono text-base font-semibold text-gold">{symbol}</span>
          <span className="font-mono text-xxs text-text-muted">
            {result.candleCount} candele · {result.summary.totalOccurrences} occorrenze pattern
            · {result.summary.uniquePatterns} unici
            {result.fromCache && <span className="ml-2 text-gold">⚡ cache</span>}
          </span>
        </div>
        <div className="flex gap-1 bg-bg-primary border border-bg-border rounded-md p-0.5">
          {[
            { id: 'frequency',   label: 'Più frequenti' },
            { id: 'performance', label: 'Più performanti' },
            { id: 'category',    label: 'Per categoria' },
          ].map(v => (
            <button key={v.id} onClick={() => setView(v.id)}
                    className={`px-2.5 py-1 rounded font-mono text-xxs ${
                      view === v.id ? 'bg-gold/20 text-gold' : 'text-text-secondary hover:text-text-primary'
                    }`}>
              {v.label}
            </button>
          ))}
        </div>
      </div>

      {/* Content */}
      {view === 'category' ? (
        <CategoryView byCategory={result.byCategory} />
      ) : (
        <PatternTable list={list?.slice(0, 20) || []} highlightField={view} />
      )}
    </div>
  )
}

function PatternTable({ list, highlightField }) {
  if (list.length === 0) return (
    <div className="px-5 py-8 text-center font-mono text-xs text-text-muted">
      Nessun pattern rilevato (forse troppe poche candele)
    </div>
  )
  return (
    <table className="w-full font-mono text-xs">
      <thead>
        <tr className="text-text-muted border-b border-bg-border bg-bg-primary/50">
          <th className="text-left  py-2 px-3">#</th>
          <th className="text-left  py-2 px-3">Pattern</th>
          <th className="text-left  py-2 px-3">Bias</th>
          <th className="text-right py-2 px-3">Occorr.</th>
          <th className="text-right py-2 px-3">WR</th>
          <th className="text-right py-2 px-3" title="Intervallo di confidenza 95% sul win rate">CI 95%</th>
          <th className="text-right py-2 px-3" title="R per trade NETTO (post-costi)">R netto</th>
          <th className="text-right py-2 px-3" title="R lordo - R netto = costo medio per trade">Costo</th>
          <th className="text-right py-2 px-3" title="Walk-forward train vs test">WF train→test</th>
          <th className="text-right py-2 px-3" title="Profit factor netto">PF</th>
          <th className="text-left  py-2 px-3">Affidabilità</th>
        </tr>
      </thead>
      <tbody>
        {list.map((p, i) => {
          const wrColor = p.winRate >= 0.55 ? '#00e096' :
                          p.winRate <  0.45 ? '#ff3355' : '#f5c842'
          const expColor = p.expectancy >= 0.3 ? '#00e096' :
                            p.expectancy <  0   ? '#ff3355' : '#f5c842'
          const biasColor = p.bias === 'bullish' ? '#00e096' : '#ff3355'
          const wf = p.walkForward
          let wfDisplay = '—'
          let wfColor = '#8892a4'
          if (wf && wf.train && wf.test && wf.train.total > 0 && wf.test.total > 0) {
            const trainWR = (wf.train.winRate * 100).toFixed(0)
            const testWR  = (wf.test.winRate * 100).toFixed(0)
            wfDisplay = `${trainWR}% → ${testWR}%`
            wfColor = wf.overfit ? '#ff3355' : (wf.test.winRate >= wf.train.winRate * 0.85 ? '#00e096' : '#f5c842')
          }
          // Riga sbiadita se troppi pochi sample
          const dim = p.significance?.level === 'noise' ? 'opacity-50' : ''
          return (
            <tr key={p.name} className={`border-b border-bg-border/50 hover:bg-bg-hover ${dim} ${
              highlightField === 'frequency' && i < 3 && p.significance?.level !== 'noise' ? 'bg-gold/5' : ''
            }`}>
              <td className="py-2 px-3 text-text-muted tabular-nums">{i + 1}</td>
              <td className="py-2 px-3 font-semibold text-text-primary">
                <div>{p.name}</div>
                <div className="font-mono text-xxs text-text-muted">{p.type}</div>
              </td>
              <td className="py-2 px-3 font-semibold" style={{ color: biasColor }}>
                {p.bias === 'bullish' ? '▲' : '▼'}
              </td>
              <td className="py-2 px-3 text-right tabular-nums font-semibold">{p.occurrences}</td>
              <td className="py-2 px-3 text-right tabular-nums font-semibold" style={{ color: wrColor }}>
                {(p.winRate * 100).toFixed(0)}%
              </td>
              <td className="py-2 px-3 text-right tabular-nums text-text-muted text-xxs">
                {p.confidenceInterval
                  ? `${(p.confidenceInterval.lower * 100).toFixed(0)}-${(p.confidenceInterval.upper * 100).toFixed(0)}%`
                  : '—'}
              </td>
              <td className="py-2 px-3 text-right tabular-nums font-semibold" style={{ color: expColor }}>
                {p.expectancy.toFixed(2)}
              </td>
              <td className="py-2 px-3 text-right tabular-nums text-text-muted text-xxs">
                {p.avgCost ? `-${p.avgCost.toFixed(3)}R` : '—'}
              </td>
              <td className="py-2 px-3 text-right tabular-nums text-xxs" style={{ color: wfColor }}>
                {wfDisplay}
                {wf?.overfit && <div className="text-xxs">⚠ overfit</div>}
              </td>
              <td className="py-2 px-3 text-right tabular-nums">
                {isFinite(p.profitFactor) ? p.profitFactor.toFixed(2) : '∞'}
              </td>
              <td className="py-2 px-3">
                <SignificanceBadge significance={p.significance} occurrences={p.occurrences} />
              </td>
            </tr>
          )
        })}
      </tbody>
    </table>
  )
}

function CategoryView({ byCategory }) {
  const cats = [
    { key: 'candlestick', label: 'Candlestick', color: '#7be0a3' },
    { key: 'chart',       label: 'Chart',       color: '#f5c842' },
    { key: 'harmonic',    label: 'Armonici',    color: '#ff7a8d' },
  ]
  return (
    <div className="grid grid-cols-1 md:grid-cols-3 gap-4 p-4">
      {cats.map(cat => (
        <div key={cat.key} className="bg-bg-primary rounded-md border border-bg-border p-3">
          <div className="font-mono text-xs font-semibold mb-2 uppercase tracking-wider"
               style={{ color: cat.color }}>
            {cat.label} ({byCategory[cat.key]?.length || 0})
          </div>
          <div className="space-y-1">
            {(byCategory[cat.key] || []).slice(0, 8).map(p => {
              const wrColor = p.winRate >= 0.55 ? '#00e096' :
                              p.winRate <  0.45 ? '#ff3355' : '#f5c842'
              return (
                <div key={p.name} className="flex items-center justify-between py-1 border-b border-bg-border/30 last:border-0">
                  <div className="flex-1 min-w-0">
                    <div className="font-mono text-xs text-text-primary truncate">{p.name}</div>
                    <div className="font-mono text-xxs text-text-muted">
                      {p.occurrences}× · R {p.expectancy.toFixed(2)}
                    </div>
                  </div>
                  <div className="font-mono text-xs font-semibold tabular-nums shrink-0" style={{ color: wrColor }}>
                    {(p.winRate * 100).toFixed(0)}%
                  </div>
                </div>
              )
            })}
            {(byCategory[cat.key]?.length || 0) === 0 && (
              <div className="font-mono text-xxs text-text-muted text-center py-3">
                Nessun pattern detectato
              </div>
            )}
          </div>
        </div>
      ))}
    </div>
  )
}

// ─── Configuration bar (broker / years / TF) ───────────────────────
function ConfigBar({ cfg }) {
  const brokers = listBrokers()
  return (
    <div className="mt-3 pt-3 border-t border-bg-border/50 grid grid-cols-1 md:grid-cols-3 gap-3">
      <div>
        <label className="font-mono text-xxs text-text-muted uppercase tracking-wider block mb-1">Broker (costi)</label>
        <select value={cfg.brokerId} onChange={e => cfg.setBrokerId(e.target.value)}
                className="w-full bg-bg-primary border border-bg-border rounded-md px-2 py-1 font-mono text-xs text-text-primary">
          {brokers.map(b => <option key={b.id} value={b.id}>{b.label}</option>)}
        </select>
      </div>
      <div>
        <label className="font-mono text-xxs text-text-muted uppercase tracking-wider block mb-1">Periodo (anni)</label>
        <select value={cfg.years} onChange={e => cfg.setYears(Number(e.target.value))}
                className="w-full bg-bg-primary border border-bg-border rounded-md px-2 py-1 font-mono text-xs text-text-primary">
          {[2, 3, 5, 7, 10].map(y => <option key={y} value={y}>{y} anni</option>)}
        </select>
      </div>
      <div>
        <label className="font-mono text-xxs text-text-muted uppercase tracking-wider block mb-1">Timeframe</label>
        <select value={cfg.timeframe} onChange={e => cfg.setTimeframe(e.target.value)}
                className="w-full bg-bg-primary border border-bg-border rounded-md px-2 py-1 font-mono text-xs text-text-primary">
          {['1h', '4h', '1D'].map(tf => <option key={tf} value={tf}>{tf}</option>)}
        </select>
      </div>
    </div>
  )
}

// ─── Significance badge ────────────────────────────────────────────
function SignificanceBadge({ significance, occurrences }) {
  if (!significance) return null
  return (
    <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded font-mono text-xxs"
          style={{ backgroundColor: `${significance.color}20`, color: significance.color, border: `1px solid ${significance.color}40` }}
          title={`${significance.hint} (${occurrences} occorrenze)`}>
      {'★'.repeat(significance.stars)}{'☆'.repeat(4 - significance.stars)}
      <span className="ml-0.5">{significance.label}</span>
    </span>
  )
}

// ─── TAB 3: Strategie ──────────────────────────────────────────────
function StrategiesTab({ apiKeys, cfg }) {
  const [running, setRunning] = useState(false)
  const [progress, setProgress] = useState('')
  const [results, setResults] = useState(null)  // { XAUUSD: [...], BTCUSD: [...] }
  const [error, setError]     = useState(null)
  const toast = useToast()

  const handleRun = async () => {
    setRunning(true)
    setError(null)
    setResults(null)
    const out = {}
    try {
      for (const symbol of ANALYSIS_SYMBOLS) {
        setProgress(`Carico ${symbol}...`)
        const { candles, fromCache } = await loadHistoricalCandles(
          symbol, cfg.timeframe, cfg.years, apiKeys.twelvedata,
          msg => setProgress(`${symbol}: ${msg}`)
        )
        setProgress(`Backtest strategie su ${symbol} (${candles.length} candele)...`)
        const res = runAllStrategies(candles, { symbol, brokerId: cfg.brokerId, walkForward: true })
        out[symbol] = { results: res, candleCount: candles.length, fromCache }
      }
      setResults(out)
      setProgress('')
      toast.success(`Backtest strategie completato`, { title: '⚡ Strategie' })
    } catch (err) {
      setError(err.message)
      toast.error(err.message, { title: 'Errore Strategie', duration: 6000 })
    } finally {
      setRunning(false)
    }
  }

  return (
    <div className="p-6 space-y-4">

      {/* Intro */}
      <div className="bg-bg-secondary rounded-xl border border-bg-border p-4">
        <div className="flex items-center justify-between gap-4 flex-wrap">
          <div className="flex-1 min-w-0">
            <div className="font-mono text-sm font-semibold text-gold mb-1">
              Strategie classiche · {cfg.years} anni · {cfg.timeframe}
            </div>
            <div className="font-mono text-xs text-text-secondary leading-relaxed">
              Le {STRATEGIES.length} strategie più usate al mondo (trend, mean-reversion, breakout, SMC, Wyckoff)
              testate <strong>con costi reali del broker</strong> + significatività + walk-forward 70/30.
            </div>
          </div>
          <div className="flex flex-col gap-2 shrink-0">
            <button onClick={handleRun} disabled={running}
                    className="px-5 py-2 rounded-md font-mono text-sm font-semibold bg-gold/20 text-gold border border-gold/50 hover:bg-gold/30 disabled:opacity-50 disabled:cursor-not-allowed">
              {running ? '⏳ In corso...' : '▶ Esegui backtest strategie'}
            </button>
          </div>
        </div>
        <ConfigBar cfg={cfg} />

        {progress && (
          <div className="mt-3 font-mono text-xs text-text-secondary bg-bg-primary rounded-md px-3 py-2">
            {progress}
          </div>
        )}
        {error && (
          <div className="mt-3 font-mono text-xs text-red bg-red/10 border border-red/30 rounded-md px-3 py-2">
            ⚠ {error}
          </div>
        )}
      </div>

      {/* Strategy cards (always visible — descrittive) */}
      {!results && (
        <div>
          <div className="font-mono text-xs text-text-muted uppercase tracking-widest mb-2">Strategie disponibili</div>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            {STRATEGIES.map(s => (
              <div key={s.id} className="bg-bg-secondary rounded-md border border-bg-border p-3">
                <div className="flex items-center gap-2 mb-1">
                  <span className="text-base text-gold">{s.icon}</span>
                  <span className="font-mono text-sm font-semibold text-text-primary">{s.name}</span>
                  <span className="font-mono text-xxs text-text-muted ml-auto uppercase">{s.style}</span>
                </div>
                <div className="font-mono text-xxs text-text-secondary leading-relaxed">{s.desc}</div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Results */}
      {results && (
        <div className="space-y-5">
          {ANALYSIS_SYMBOLS.map(symbol => {
            const data = results[symbol]
            if (!data) return null
            return <StrategyResults key={symbol} symbol={symbol} data={data} />
          })}
        </div>
      )}
    </div>
  )
}

function StrategyResults({ symbol, data }) {
  // Ordina per profit factor desc
  const sorted = [...data.results].sort((a, b) => {
    const pfA = a.result.summary?.profitFactor ?? 0
    const pfB = b.result.summary?.profitFactor ?? 0
    return pfB - pfA
  })

  return (
    <div className="bg-bg-secondary rounded-xl border border-bg-border overflow-hidden">
      <div className="px-5 py-3 border-b border-bg-border flex items-center justify-between flex-wrap gap-2">
        <span className="font-mono text-base font-semibold text-gold">{symbol}</span>
        <span className="font-mono text-xxs text-text-muted">
          {data.candleCount} candele · {STRATEGIES.length} strategie testate
          {data.fromCache && <span className="ml-2 text-gold">⚡ cache</span>}
        </span>
      </div>

      <table className="w-full font-mono text-xs">
        <thead>
          <tr className="text-text-muted border-b border-bg-border bg-bg-primary/50">
            <th className="text-left  py-2 px-3">#</th>
            <th className="text-left  py-2 px-3">Strategia</th>
            <th className="text-right py-2 px-3">Trade</th>
            <th className="text-right py-2 px-3">WR</th>
            <th className="text-right py-2 px-3" title="CI 95% sul win rate">CI 95%</th>
            <th className="text-right py-2 px-3" title="R medio post-costi">R netto</th>
            <th className="text-right py-2 px-3" title="Costo medio per trade in R">Costo</th>
            <th className="text-right py-2 px-3" title="Walk-forward 70/30">WF</th>
            <th className="text-right py-2 px-3" title="Profit factor netto">PF</th>
            <th className="text-right py-2 px-3" title="Sharpe ratio sui R per trade">Sharpe</th>
            <th className="text-right py-2 px-3">Max DD</th>
            <th className="text-right py-2 px-3">Equity</th>
            <th className="text-left  py-2 px-3">Affidabilità</th>
          </tr>
        </thead>
        <tbody>
          {sorted.map(({ strategy, result }, i) => {
            const s = result.summary
            if (!s || s.total === 0) {
              return (
                <tr key={strategy.id} className="border-b border-bg-border/50 opacity-50">
                  <td className="py-2 px-3 text-text-muted">{i + 1}</td>
                  <td className="py-2 px-3" colSpan={12}>
                    <span className="font-semibold">{strategy.icon} {strategy.name}</span>
                    <span className="ml-3 text-text-muted">— {result.error || 'nessun trade'}</span>
                  </td>
                </tr>
              )
            }
            const wrColor = s.winRate >= 0.55 ? '#00e096' :
                            s.winRate <  0.45 ? '#ff3355' : '#f5c842'
            const pfColor = s.profitFactor >= 1.5 ? '#00e096' :
                            s.profitFactor <  1   ? '#ff3355' : '#f5c842'
            const eqColor = s.finalEquity >= 0 ? '#00e096' : '#ff3355'
            const wf = s.walkForward
            let wfDisplay = '—', wfColor = '#8892a4'
            if (wf && wf.train && wf.test) {
              wfDisplay = `${(wf.train.winRate * 100).toFixed(0)}→${(wf.test.winRate * 100).toFixed(0)}%`
              wfColor = wf.overfit ? '#ff3355' : (wf.test.winRate >= wf.train.winRate * 0.85 ? '#00e096' : '#f5c842')
            }
            const dim = s.significance?.level === 'noise' ? 'opacity-50' : ''
            return (
              <tr key={strategy.id} className={`border-b border-bg-border/50 hover:bg-bg-hover ${dim} ${
                i < 3 && s.significance?.level !== 'noise' ? 'bg-gold/5' : ''
              }`}>
                <td className="py-2 px-3 text-text-muted tabular-nums">{i + 1}</td>
                <td className="py-2 px-3">
                  <div className="font-semibold text-text-primary">{strategy.icon} {strategy.name}</div>
                  <div className="text-text-muted text-xxs uppercase">{strategy.style}</div>
                </td>
                <td className="py-2 px-3 text-right tabular-nums">{s.total}</td>
                <td className="py-2 px-3 text-right tabular-nums font-semibold" style={{ color: wrColor }}>
                  {(s.winRate * 100).toFixed(0)}%
                </td>
                <td className="py-2 px-3 text-right tabular-nums text-text-muted text-xxs">
                  {s.confidenceInterval
                    ? `${(s.confidenceInterval.lower * 100).toFixed(0)}-${(s.confidenceInterval.upper * 100).toFixed(0)}%`
                    : '—'}
                </td>
                <td className="py-2 px-3 text-right tabular-nums">{s.avgRR.toFixed(2)}</td>
                <td className="py-2 px-3 text-right tabular-nums text-text-muted text-xxs">
                  -{(s.avgCost || 0).toFixed(3)}R
                </td>
                <td className="py-2 px-3 text-right tabular-nums text-xxs" style={{ color: wfColor }}>
                  {wfDisplay}
                  {wf?.overfit && <div>⚠</div>}
                </td>
                <td className="py-2 px-3 text-right tabular-nums font-semibold" style={{ color: pfColor }}>
                  {isFinite(s.profitFactor) ? s.profitFactor.toFixed(2) : '∞'}
                </td>
                <td className="py-2 px-3 text-right tabular-nums text-text-muted">
                  {s.sharpe != null ? s.sharpe.toFixed(2) : '—'}
                </td>
                <td className="py-2 px-3 text-right tabular-nums text-red/70">{s.maxDD.toFixed(1)}R</td>
                <td className="py-2 px-3 text-right tabular-nums font-semibold" style={{ color: eqColor }}>
                  {s.finalEquity >= 0 ? '+' : ''}{s.finalEquity.toFixed(1)}R
                </td>
                <td className="py-2 px-3">
                  <SignificanceBadge significance={s.significance} occurrences={s.total} />
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

// ─── Componenti del SignalsTab esistente ────────────────────────────
function InstrumentResults({ symbol, result }) {
  const { byLabel, summary } = result
  const total = summary?.total || 0

  if (total === 0) {
    return (
      <div className="bg-bg-secondary rounded-xl border border-bg-border p-5">
        <div className="flex items-center justify-between mb-2">
          <span className="font-mono text-base font-semibold text-gold">{symbol}</span>
          <span className="font-mono text-xs text-text-muted">Nessun trade rilevato</span>
        </div>
      </div>
    )
  }

  const summaryColor = summary.winRate >= 0.55 ? '#00e096' :
                        summary.winRate <  0.45 ? '#ff3355' : '#f5c842'

  return (
    <div className="bg-bg-secondary rounded-xl border border-bg-border overflow-hidden">

      <div className="px-5 py-3 border-b border-bg-border flex items-center justify-between flex-wrap gap-2">
        <span className="font-mono text-base font-semibold text-gold">{symbol}</span>
        <div className="flex items-center gap-4 flex-wrap">
          <Stat label="Trade"   value={summary.total} />
          <Stat label="Win rate" value={(summary.winRate * 100).toFixed(0) + '%'} color={summaryColor} />
          <Stat label="Profit Factor" value={isFinite(summary.profitFactor) ? summary.profitFactor.toFixed(2) : '∞'}
                color={summary.profitFactor >= 1.5 ? '#00e096' : summary.profitFactor < 1 ? '#ff3355' : '#f5c842'} />
          <Stat label="R:R medio" value={summary.avgRR.toFixed(2)}
                color={summary.avgRR >= 0 ? '#00e096' : '#ff3355'} />
          <Stat label="Max DD"   value={summary.maxDD.toFixed(1) + 'R'} color="#ff7a8d" />
          {summary.sharpe != null && (
            <Stat label="Sharpe" value={summary.sharpe.toFixed(2)}
                  color={summary.sharpe >= 1 ? '#00e096' : summary.sharpe < 0.5 ? '#ff3355' : '#f5c842'} />
          )}
        </div>
      </div>

      <table className="w-full font-mono text-xs">
        <thead>
          <tr className="text-text-muted border-b border-bg-border bg-bg-primary/50">
            <th className="text-left  py-2 px-4">Segnale</th>
            <th className="text-right py-2 px-4">Trade</th>
            <th className="text-right py-2 px-4">Win</th>
            <th className="text-right py-2 px-4">Loss</th>
            <th className="text-right py-2 px-4">Win Rate</th>
            <th className="text-right py-2 px-4">Profit Factor</th>
            <th className="text-right py-2 px-4">R:R medio</th>
            <th className="text-right py-2 px-4">Expectancy</th>
            <th className="text-right py-2 px-4">Max DD</th>
          </tr>
        </thead>
        <tbody>
          {SIGNAL_LABELS.map(label => {
            const stats = byLabel[label]
            if (!stats) return null
            const wrColor = stats.winRate >= 0.55 ? '#00e096' :
                            stats.winRate <  0.45 ? '#ff3355' : '#f5c842'
            return (
              <tr key={label} className="border-b border-bg-border/50 hover:bg-bg-hover">
                <td className="py-2 px-4">
                  <span className="font-semibold" style={{ color: SIGNAL_COLOR[label] }}>{label}</span>
                </td>
                <td className="py-2 px-4 text-right tabular-nums">{stats.total}</td>
                <td className="py-2 px-4 text-right tabular-nums text-green">{stats.wins}</td>
                <td className="py-2 px-4 text-right tabular-nums text-red">{stats.losses}</td>
                <td className="py-2 px-4 text-right tabular-nums font-semibold" style={{ color: wrColor }}>
                  {(stats.winRate * 100).toFixed(0)}%
                </td>
                <td className="py-2 px-4 text-right tabular-nums">
                  {isFinite(stats.profitFactor) ? stats.profitFactor.toFixed(2) : '∞'}
                </td>
                <td className="py-2 px-4 text-right tabular-nums">{stats.avgRR.toFixed(2)}</td>
                <td className="py-2 px-4 text-right tabular-nums">{stats.expectancy.toFixed(3)}</td>
                <td className="py-2 px-4 text-right tabular-nums text-red/70">{stats.maxDD.toFixed(1)}R</td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

function Stat({ label, value, color = '#e5e7eb' }) {
  return (
    <div className="text-right">
      <div className="font-mono text-xxs text-text-muted uppercase tracking-wider">{label}</div>
      <div className="font-mono text-base font-semibold tabular-nums" style={{ color }}>{value}</div>
    </div>
  )
}
