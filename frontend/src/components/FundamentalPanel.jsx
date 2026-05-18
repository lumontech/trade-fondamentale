import { useEffect, useState, useMemo } from 'react'
import { fetchFFCalendar, groupByDay } from '../services/ForexFactoryService'
import { findRuleForEvent } from '../services/MacroRules'

const IMPACT_STYLE = {
  High:    { bg: '#ff335520', dot: '#ff3355', text: '#ff3355', label: 'ALTO'    },
  Medium:  { bg: '#f5c84220', dot: '#f5c842', text: '#f5c842', label: 'MEDIO'   },
  Low:     { bg: '#8892a420', dot: '#8892a4', text: '#8892a4', label: 'BASSO'   },
  Holiday: { bg: '#2196F320', dot: '#2196F3', text: '#2196F3', label: 'FESTIVO' },
}

const CURRENCY_FILTERS = ['ALL', 'USD', 'EUR', 'GBP', 'JPY', 'CHF', 'AUD', 'CAD', 'NZD']
const IMPACT_FILTERS   = ['ALL', 'High', 'Medium', 'Low']

// Regole di analisi fondamentale — sempre visibili nella sidebar
const RULES = [
  {
    title: 'Eventi ad alto impatto = volatilità',
    body:  'NFP, decisioni dei tassi (Fed, ECB, BOE), CPI/PPI, PMI generano spike improvvisi. Evita di entrare 30 min prima e 30 min dopo l\'uscita.',
  },
  {
    title: 'Forecast vs Precedente',
    body:  'Il mercato muove sulla SORPRESA, non sul dato in sé. Se il dato è meglio del forecast → valuta forte. Peggio del forecast → valuta debole.',
  },
  {
    title: 'Decisioni sui tassi',
    body:  'Tassi alzati → valuta tipicamente forte. Tagliati → valuta debole. Più importante è il TONO della conferenza stampa successiva (hawkish/dovish).',
  },
  {
    title: 'Correlazioni macro',
    body:  'Dollaro forte → oro debole, indici USA spesso giù. Petrolio su → CAD forte. Risk-off → JPY/CHF forti, AUD/NZD deboli.',
  },
  {
    title: 'Sessioni operative',
    body:  'Volatilità massima durante l\'overlap Londra-NY (14:00-17:00 UTC). I dati USA escono alle 14:30 UTC, BCE alle 13:45 UTC.',
  },
  {
    title: 'Bias direzionale',
    body:  'Allinea l\'analisi tecnica al fondamentale: se la Fed è hawkish + EMA200 ribassista su EURUSD → bias short coerente.',
  },
]

export default function FundamentalPanel() {
  const [events,   setEvents]   = useState([])
  const [loading,  setLoading]  = useState(true)
  const [error,    setError]    = useState(null)
  const [curFilter, setCurFilter] = useState('ALL')
  const [impFilter, setImpFilter] = useState('High')

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    fetchFFCalendar()
      .then(data => { if (!cancelled) { setEvents(data); setError(null) } })
      .catch(err  => { if (!cancelled) setError(err.message) })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [])

  const filtered = useMemo(() =>
    events.filter(e =>
      (curFilter === 'ALL' || e.currency === curFilter) &&
      (impFilter === 'ALL' || e.impact === impFilter)
    ), [events, curFilter, impFilter])

  const grouped = useMemo(() => groupByDay(filtered), [filtered])

  const now = new Date()
  const fmtTime = d => d.toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' })

  // Stats
  const stats = useMemo(() => {
    const high   = events.filter(e => e.impact === 'High').length
    const medium = events.filter(e => e.impact === 'Medium').length
    const today  = events.filter(e => {
      const d = e.date
      const t = new Date()
      return d.toDateString() === t.toDateString()
    })
    const upcoming = events
      .filter(e => e.date > now && (e.impact === 'High' || e.impact === 'Medium'))
      .sort((a,b) => a.date - b.date)[0]
    return { high, medium, todayCount: today.length, next: upcoming }
  }, [events])

  return (
    <div className="h-full flex bg-bg-primary overflow-hidden">

      {/* ── Sidebar regole (sinistra) ──────────────────────────── */}
      <aside className="w-80 shrink-0 border-r border-bg-border bg-bg-secondary overflow-y-auto">
        <div className="px-5 py-4 border-b border-bg-border">
          <h3 className="font-mono text-base font-semibold text-gold tracking-wider">
            REGOLE OPERATIVE
          </h3>
          <p className="font-mono text-xs text-text-secondary mt-1">
            Principi di analisi fondamentale da ricordare prima di operare
          </p>
        </div>

        <div className="p-4 space-y-3">
          {RULES.map((r, i) => (
            <div key={i} className="bg-bg-primary rounded-lg border border-bg-border p-3">
              <div className="flex items-start gap-2">
                <span className="font-mono text-xs text-gold font-semibold shrink-0">
                  {String(i + 1).padStart(2, '0')}
                </span>
                <div>
                  <div className="font-mono text-sm font-semibold text-text-primary mb-1">
                    {r.title}
                  </div>
                  <p className="font-mono text-xs text-text-secondary leading-relaxed">
                    {r.body}
                  </p>
                </div>
              </div>
            </div>
          ))}
        </div>
      </aside>

      {/* ── Main calendario (destra) ───────────────────────────── */}
      <main className="flex-1 flex flex-col overflow-hidden">

        {/* Top bar: stats + filtri */}
        <div className="px-6 py-4 border-b border-bg-border bg-bg-secondary">
          <div className="flex items-center justify-between mb-4">
            <div>
              <h2 className="font-mono text-xl font-semibold text-gold tracking-wider">
                📅 CALENDARIO ECONOMICO
              </h2>
              <p className="font-mono text-xs text-text-secondary mt-0.5">
                Forex Factory — settimana corrente
              </p>
            </div>

            {/* Stats cards */}
            <div className="flex gap-3">
              <StatCard label="Eventi totali" value={events.length} color="#8892a4" />
              <StatCard label="Alto impatto"  value={stats.high}    color="#ff3355" />
              <StatCard label="Medio impatto" value={stats.medium}  color="#f5c842" />
              <StatCard label="Oggi"          value={stats.todayCount} color="#00e096" />
            </div>
          </div>

          {/* Prossimo evento */}
          {stats.next && (
            <div className="flex items-center gap-3 px-3 py-2 bg-bg-primary rounded-lg border border-gold/30">
              <span className="font-mono text-xs text-gold uppercase tracking-wider">Prossimo evento</span>
              <span className="font-mono text-sm font-semibold text-text-primary">
                {stats.next.title}
              </span>
              <span className="px-2 py-0.5 rounded font-mono text-xs"
                    style={{ backgroundColor: IMPACT_STYLE[stats.next.impact].bg, color: IMPACT_STYLE[stats.next.impact].text }}>
                {stats.next.currency} • {IMPACT_STYLE[stats.next.impact].label}
              </span>
              <span className="font-mono text-xs text-text-secondary ml-auto tabular-nums">
                {stats.next.date.toLocaleString('it-IT', { weekday: 'short', hour: '2-digit', minute: '2-digit' })}
              </span>
            </div>
          )}

          {/* Filtri */}
          <div className="flex items-center gap-4 mt-3">
            <FilterRow label="Valuta" options={CURRENCY_FILTERS} active={curFilter} onSelect={setCurFilter} />
            <div className="w-px h-6 bg-bg-border" />
            <FilterRow label="Impatto" options={IMPACT_FILTERS} active={impFilter} onSelect={setImpFilter}
                       impactColors />
          </div>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto p-6">
          {loading && (
            <div className="flex items-center justify-center h-full">
              <span className="font-mono text-base text-text-muted">⏳ Caricamento eventi...</span>
            </div>
          )}

          {error && (
            <div className="flex flex-col items-center justify-center h-full gap-2 max-w-md mx-auto text-center">
              <span className="text-red font-mono text-base">⚠ Errore nel caricamento</span>
              <span className="font-mono text-sm text-text-muted">{error}</span>
              <span className="font-mono text-xs text-text-muted">
                Verifica che corsproxy.io sia raggiungibile.
              </span>
            </div>
          )}

          {!loading && !error && Object.keys(grouped).length === 0 && (
            <div className="flex items-center justify-center h-full">
              <span className="font-mono text-base text-text-muted">
                Nessun evento corrisponde ai filtri selezionati.
              </span>
            </div>
          )}

          {!loading && !error && Object.entries(grouped).map(([day, evs]) => (
            <DayBlock key={day} day={day} events={evs} now={now} fmtTime={fmtTime} />
          ))}
        </div>
      </main>
    </div>
  )
}

// ─── Sub components ─────────────────────────────────────────────

function StatCard({ label, value, color }) {
  return (
    <div className="bg-bg-primary rounded-lg border border-bg-border px-3 py-2 min-w-[80px]">
      <div className="font-mono text-xs text-text-muted uppercase tracking-wider">{label}</div>
      <div className="font-mono text-2xl font-semibold tabular-nums" style={{ color }}>{value}</div>
    </div>
  )
}

function FilterRow({ label, options, active, onSelect, impactColors }) {
  return (
    <div className="flex items-center gap-2">
      <span className="font-mono text-xs text-text-muted uppercase">{label}:</span>
      <div className="flex gap-1.5">
        {options.map(o => {
          const isActive = active === o
          let activeStyle = { backgroundColor: '#f5c84220', color: '#f5c842', borderColor: '#f5c84260' }
          if (impactColors && IMPACT_STYLE[o]) {
            activeStyle = isActive
              ? { backgroundColor: IMPACT_STYLE[o].bg, color: IMPACT_STYLE[o].text, borderColor: IMPACT_STYLE[o].text + '60' }
              : {}
          }
          return (
            <button key={o}
              onClick={() => onSelect(o)}
              className={`px-2.5 py-1 rounded-md text-xs font-mono border transition-all
                ${isActive
                  ? ''
                  : 'border-transparent text-text-secondary hover:text-text-primary hover:bg-bg-hover'}`}
              style={isActive ? activeStyle : {}}>
              {o === 'High' ? 'Alto' : o === 'Medium' ? 'Medio' : o === 'Low' ? 'Basso' : o}
            </button>
          )
        })}
      </div>
    </div>
  )
}

function DayBlock({ day, events, now, fmtTime }) {
  const [expanded, setExpanded] = useState({})
  const toggle = (id) => setExpanded(s => ({ ...s, [id]: !s[id] }))

  return (
    <div className="mb-6">
      <div className="font-mono text-sm uppercase tracking-widest text-gold mb-3 sticky top-0 bg-bg-primary py-2 z-10 border-b border-bg-border">
        {day}
      </div>
      <div className="space-y-1.5">
        {events.map((e, i) => {
          const past  = e.date < now
          const style = IMPACT_STYLE[e.impact] || IMPACT_STYLE.Low
          const rule  = (e.impact === 'High' || e.impact === 'Medium') ? findRuleForEvent(e) : null
          const isExpanded = expanded[i]
          return (
            <div key={i}
              className={`rounded-md bg-bg-secondary border border-bg-border hover:border-gold/30 transition-colors
                ${past ? 'opacity-50' : ''}`}>
              <div className={`grid grid-cols-[80px_60px_120px_1fr_120px_120px_30px] gap-3 items-center px-3 py-2.5
                ${rule ? 'cursor-pointer' : ''}`}
                   onClick={() => rule && toggle(i)}>

                <span className="font-mono text-base font-semibold tabular-nums text-text-primary">
                  {fmtTime(e.date)}
                </span>

                <span className="font-mono text-sm font-semibold text-gold">
                  {e.currency}
                </span>

                <span className="flex items-center gap-2 px-2 py-0.5 rounded text-xs font-mono w-fit"
                      style={{ backgroundColor: style.bg, color: style.text }}>
                  <span className="w-2 h-2 rounded-full" style={{ backgroundColor: style.dot }} />
                  {style.label}
                </span>

                <span className="font-mono text-sm text-text-primary truncate">
                  {e.title}
                </span>

                <div className="text-right">
                  <div className="font-mono text-xs text-text-muted">Forecast</div>
                  <div className="font-mono text-sm tabular-nums text-text-primary">
                    {e.forecast || '—'}
                  </div>
                </div>

                <div className="text-right">
                  <div className="font-mono text-xs text-text-muted">Precedente</div>
                  <div className="font-mono text-sm tabular-nums text-text-secondary">
                    {e.previous || '—'}
                  </div>
                </div>

                <div className="flex items-center justify-center">
                  {rule && (
                    <span className="font-mono text-xs text-gold opacity-60 hover:opacity-100" title="Mostra regola macro">
                      {isExpanded ? '▾' : '▸'}
                    </span>
                  )}
                </div>
              </div>

              {rule && isExpanded && (
                <div className="px-4 pb-3 pt-1 border-t border-bg-border/50">
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-3 mt-2">
                    <div className="bg-bg-primary rounded-md p-3 border border-bg-border">
                      <div className="font-mono text-xs font-semibold text-gold mb-1">📚 {rule.title}</div>
                      <div className="font-mono text-xxs text-text-muted mb-2">{rule.timing}</div>
                      <p className="font-sans text-xs text-text-secondary leading-relaxed">{rule.description}</p>
                    </div>
                    <div className="space-y-2">
                      {rule.rule_higher_than_forecast && (
                        <div className="bg-green/5 rounded-md p-2 border border-green/20">
                          <div className="font-mono text-xs font-semibold text-green mb-0.5">▲ Se SOPRA forecast</div>
                          <p className="font-sans text-xs text-text-primary leading-snug">{rule.rule_higher_than_forecast.explanation}</p>
                        </div>
                      )}
                      {rule.rule_lower_than_forecast && (
                        <div className="bg-red/5 rounded-md p-2 border border-red/20">
                          <div className="font-mono text-xs font-semibold text-red mb-0.5">▼ Se SOTTO forecast</div>
                          <p className="font-sans text-xs text-text-primary leading-snug">{rule.rule_lower_than_forecast.explanation}</p>
                        </div>
                      )}
                      {rule.rule_rate_hike && (
                        <div className="bg-green/5 rounded-md p-2 border border-green/20">
                          <div className="font-mono text-xs font-semibold text-green mb-0.5">▲ Se HIKE (rialzo)</div>
                          <p className="font-sans text-xs text-text-primary leading-snug">{rule.rule_rate_hike.explanation}</p>
                        </div>
                      )}
                      {rule.rule_rate_cut && (
                        <div className="bg-red/5 rounded-md p-2 border border-red/20">
                          <div className="font-mono text-xs font-semibold text-red mb-0.5">▼ Se CUT (taglio)</div>
                          <p className="font-sans text-xs text-text-primary leading-snug">{rule.rule_rate_cut.explanation}</p>
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}
