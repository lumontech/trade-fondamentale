// ClaudeReviewPanel — Self-Learning Lab UI
// L'utente può:
//   1. Vedere tutte le decisioni passate (open + closed + dismissed + FLAT)
//   2. Lanciare review singola → Claude valuta con hindsight
//   3. Batch review delle ultime N (rate-limited 500ms tra le call)
//   4. Vedere report aggregato: accuracy %, calibration bias, top lessons
//   5. "Genera lezioni" → estrae lessons → si iniettano nel prompt principale
import { useState, useMemo, useEffect } from 'react'
import { useAppStore } from '../store/store'
import {
  reviewDecision, reviewLastN, getAllReviews, getReview,
  aggregateReport, rebuildLessons, getLessons, clearLessons,
} from '../services/ClaudeReviewLab'
import { getAllDecisions, deleteDecision, correctOutcome } from '../services/TradeLog'
import { useToast } from './ui/Toast'

const STATUS_COLOR = {
  open:      '#f5c842',
  closed:    '#00e096',
  dismissed: '#5a6478',
}
const DIR_COLOR = {
  LONG:  '#00e096',
  SHORT: '#ff3355',
  FLAT:  '#f5c842',
}

export default function ClaudeReviewPanel() {
  const setPanel = useAppStore(s => s.setActivePanel)
  const apiKeys  = useAppStore(s => s.apiKeys)
  const toast    = useToast()

  const [filter, setFilter] = useState('all')       // all|open|closed|flat
  const [symbolFilter, setSymbolFilter] = useState('')
  const [busy, setBusy] = useState(false)
  const [progress, setProgress] = useState(null)    // { current, total, decision }
  const [tick, setTick] = useState(0)               // force re-render after operations
  const refresh = () => setTick(t => t + 1)

  const decisions = useMemo(() => getAllDecisions(), [tick])
  const reviews   = useMemo(() => getAllReviews(),   [tick])
  const report    = useMemo(() => aggregateReport(), [tick])
  const lessons   = useMemo(() => getLessons(),      [tick])
  const reviewById = useMemo(() => Object.fromEntries(reviews.map(r => [r.decisionId, r])), [reviews])

  const symbols = useMemo(() => [...new Set(decisions.map(d => d.symbol))].sort(), [decisions])

  const filtered = decisions.filter(d => {
    if (symbolFilter && d.symbol !== symbolFilter) return false
    if (filter === 'all') return true
    if (filter === 'flat') return d.direction === 'FLAT'
    return d.status === filter
  })

  const handleReviewOne = async (id) => {
    if (!apiKeys.anthropic) { toast.error('API key Anthropic mancante'); return }
    setBusy(true)
    try {
      await reviewDecision(id, apiKeys.anthropic)
      toast.success('Review completata', { duration: 2500 })
      refresh()
    } catch (err) {
      toast.error(err.message, { title: 'Errore review' })
    } finally {
      setBusy(false)
    }
  }

  const handleBatchReview = async (n) => {
    if (!apiKeys.anthropic) { toast.error('API key Anthropic mancante'); return }
    setBusy(true)
    setProgress({ current: 0, total: n, decision: null })
    try {
      const results = await reviewLastN(n, apiKeys.anthropic, 'claude-opus-4-7', (p) => setProgress(p))
      const ok  = results.filter(r => r.ok).length
      const ko  = results.length - ok
      toast.success(`${ok} review OK / ${ko} errori`, { title: 'Batch review completata', duration: 4000 })
      refresh()
    } catch (err) {
      toast.error(err.message)
    } finally {
      setBusy(false); setProgress(null)
    }
  }

  const handleRebuildLessons = () => {
    const out = rebuildLessons()
    if (out) toast.success(`${out.lessons.length} lezioni estratte — iniezione prompt attiva`,
                          { title: '🧠 Self-learning aggiornato' })
    else     toast.warning('Nessuna review disponibile per estrarre lezioni')
    refresh()
  }

  const handleClearLessons = () => {
    clearLessons()
    toast.info('Lezioni rimosse — prompt principale torna a default')
    refresh()
  }

  return (
    <div className="h-full flex flex-col bg-bg-primary overflow-hidden">
      <Header onClose={() => setPanel('chart')} />

      {/* Action bar */}
      <div className="border-b border-bg-border bg-bg-secondary/50 px-4 py-2.5 shrink-0">
        <div className="flex items-center gap-3 flex-wrap">
          <div className="flex gap-0.5 bg-bg-primary border border-bg-border rounded-md p-0.5">
            {['all', 'open', 'closed', 'flat', 'dismissed'].map(f => (
              <button key={f} onClick={() => setFilter(f)}
                      className={`px-2.5 py-1 rounded font-mono text-xxs uppercase transition-all ${
                        filter === f ? 'bg-gold/20 text-gold' : 'text-text-secondary hover:text-text-primary'
                      }`}>
                {f}
              </button>
            ))}
          </div>

          <select value={symbolFilter} onChange={e => setSymbolFilter(e.target.value)}
                  className="bg-bg-primary border border-bg-border rounded-md px-2 py-1 font-mono text-xs text-text-primary">
            <option value="">Tutti i simboli</option>
            {symbols.map(s => <option key={s} value={s}>{s}</option>)}
          </select>

          <span className="font-mono text-xxs text-text-muted">
            {filtered.length} decisioni · {reviews.length} review
          </span>

          <div className="flex-1" />

          <button onClick={() => handleBatchReview(10)} disabled={busy || decisions.length === 0}
                  className="px-3 py-1.5 rounded-md font-mono text-xs bg-gold/15 text-gold border border-gold/40 hover:bg-gold/25 disabled:opacity-50">
            🔄 Review ultime 10
          </button>
          <button onClick={() => handleBatchReview(Math.min(20, decisions.length))} disabled={busy || decisions.length === 0}
                  className="px-3 py-1.5 rounded-md font-mono text-xs bg-gold/15 text-gold border border-gold/40 hover:bg-gold/25 disabled:opacity-50">
            🔄 Review ultime 20
          </button>
          <button onClick={handleRebuildLessons} disabled={reviews.length === 0}
                  title="Estrae le lezioni più ricorrenti e le inietta nel SYSTEM_PROMPT delle prossime analisi Claude"
                  className="px-3 py-1.5 rounded-md font-mono text-xs bg-purple-500/15 text-purple-300 border border-purple-500/40 hover:bg-purple-500/25 disabled:opacity-50">
            🧠 Genera lezioni → prompt
          </button>
        </div>
        {progress && (
          <div className="mt-2 flex items-center gap-3">
            <div className="flex-1 h-1.5 bg-bg-primary rounded-full overflow-hidden">
              <div className="h-full bg-gold transition-all"
                   style={{ width: `${(progress.current / progress.total) * 100}%` }} />
            </div>
            <span className="font-mono text-xxs text-text-muted">
              {progress.current}/{progress.total}
              {progress.decision ? ` · ${progress.decision.symbol} ${progress.decision.direction}` : ''}
            </span>
          </div>
        )}
      </div>

      <div className="flex-1 flex overflow-hidden">

        {/* Main: lista decisioni con review */}
        <div className="flex-1 overflow-y-auto p-4 min-w-0">
          {filtered.length === 0 ? (
            <EmptyState filter={filter} />
          ) : (
            <div className="space-y-2.5">
              {filtered.map(d => (
                <DecisionReviewCard
                  key={d.id}
                  decision={d}
                  review={reviewById[d.id]?.review}
                  reviewedAt={reviewById[d.id]?.reviewed_at}
                  onReview={() => handleReviewOne(d.id)}
                  onDelete={() => {
                    if (confirm(`Eliminare decisione ${d.symbol} ${d.direction}?`)) {
                      deleteDecision(d.id); refresh()
                    }
                  }}
                  onCorrect={(correction) => {
                    const r = correctOutcome(d.id, correction)
                    if (r) {
                      toast.success('Outcome corretto manualmente', { duration: 2500 })
                      refresh()
                    } else {
                      toast.error('Correzione fallita')
                    }
                  }}
                  busy={busy}
                />
              ))}
            </div>
          )}
        </div>

        {/* Sidebar: aggregate report + lessons */}
        <aside className="w-[380px] shrink-0 border-l border-bg-border bg-bg-secondary/30 overflow-y-auto p-4">
          <ReportSummary report={report} />
          <LessonsBox lessons={lessons} onClear={handleClearLessons} />
        </aside>
      </div>
    </div>
  )
}

// ─── Sub-components ─────────────────────────────────────────────────
function Header({ onClose }) {
  return (
    <div className="flex items-center justify-between px-5 py-3 border-b border-bg-border bg-bg-secondary shrink-0">
      <div>
        <h2 className="font-mono text-lg font-semibold text-gold tracking-wider">
          🧪 CLAUDE REVIEW LAB — Self-Learning
        </h2>
        <p className="font-mono text-xxs text-text-muted mt-0.5">
          Claude rivede le sue decisioni passate, estrae lezioni, le inietta nel prompt delle prossime analisi
        </p>
      </div>
      <button onClick={onClose}
              className="font-mono text-xs text-text-secondary hover:text-text-primary px-3 py-1.5 hover:bg-bg-hover rounded-md border border-bg-border">
        ✕ Chiudi
      </button>
    </div>
  )
}

function EmptyState({ filter }) {
  return (
    <div className="flex flex-col items-center justify-center h-full text-center max-w-md mx-auto pt-12">
      <div className="text-5xl mb-3">📭</div>
      <h3 className="font-mono text-lg text-gold mb-2">Nessuna decisione {filter !== 'all' ? `(${filter})` : ''}</h3>
      <p className="font-mono text-sm text-text-secondary leading-relaxed">
        Fai qualche analisi nel pannello "🧠 Decisione Claude" — ogni risposta viene salvata
        automaticamente qui, anche FLAT/wait. Poi torna e lancia "Review ultime 10/20" per
        farle ri-analizzare con il senno di poi.
      </p>
    </div>
  )
}

function DecisionReviewCard({ decision, review, reviewedAt, onReview, onDelete, onCorrect, busy }) {
  const [expanded, setExpanded] = useState(false)
  const [correctOpen, setCorrectOpen] = useState(false)
  const d = decision
  const r = review
  const dirColor = DIR_COLOR[d.direction]
  const statusColor = STATUS_COLOR[d.status]

  const verdictColor = r?.verdict_correct === 'right' ? '#00e096'
                     : r?.verdict_correct === 'wrong' ? '#ff3355'
                     : '#f5c842'
  const verdictIcon  = r?.verdict_correct === 'right' ? '✓'
                     : r?.verdict_correct === 'wrong' ? '✗'
                     : r ? '~' : '?'

  return (
    <div className="bg-bg-secondary rounded-lg border border-bg-border overflow-hidden">
      <div className="flex items-center gap-3 p-3">
        {/* Verdict big icon */}
        <div className="text-2xl font-bold w-10 text-center shrink-0" style={{ color: verdictColor }}>
          {verdictIcon}
        </div>

        {/* Main info */}
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-1">
            <span className="font-mono text-sm font-semibold text-text-primary">{d.symbol}</span>
            <span className="font-mono text-xs text-text-muted">{d.timeframe}</span>
            <span className="font-mono text-xs font-bold" style={{ color: dirColor }}>
              {d.direction}
            </span>
            <span className="font-mono text-xs text-text-secondary">{d.confidence}%</span>
            <span className="font-mono text-xxs uppercase tracking-wider" style={{ color: statusColor }}>
              · {d.status}
            </span>
          </div>
          <div className="font-mono text-xxs text-text-muted">
            {new Date(d.openedAt).toLocaleString('it-IT', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })}
            {d.exitPrice != null && (
              <span> · exit {d.exitPrice} · R {d.rMultiple?.toFixed?.(2) ?? '—'} · P&L {d.pnlPct?.toFixed?.(2) ?? '—'}%</span>
            )}
            {d.manuallyCorrected && (
              <span className="ml-2 px-1.5 py-0.5 rounded bg-orange-500/20 text-orange-300 text-xxs font-bold">
                MANUAL
              </span>
            )}
          </div>
          {r && (
            <div className="font-mono text-xs text-text-primary mt-1.5 italic">
              "{r.outcome_summary}"
            </div>
          )}
        </div>

        {/* Actions */}
        <div className="flex flex-col gap-1 shrink-0">
          <button onClick={onReview} disabled={busy}
                  className="px-2.5 py-1 rounded font-mono text-xxs bg-gold/15 text-gold border border-gold/40 hover:bg-gold/25 disabled:opacity-50">
            {r ? '↻ Re-Review' : '🔍 Review'}
          </button>
          {/* Sia per closed (correggi outcome divergente) sia per open (chiudi manualmente
              quando broker ha già chiuso ma sistema non ha rilevato): stesso modal. */}
          {(d.direction === 'LONG' || d.direction === 'SHORT') && onCorrect && (
            <button onClick={() => setCorrectOpen(true)}
                    title={d.status === 'open'
                      ? "Trade aperto sul broker ma chiuso? Usa qui per chiuderlo manualmente con exit_price reale."
                      : "Correggi outcome se il broker reale ha avuto un risultato diverso dai dati Yahoo"}
                    className="px-2.5 py-1 rounded font-mono text-xxs bg-orange-500/15 text-orange-300 border border-orange-500/40 hover:bg-orange-500/25">
              {d.status === 'open' ? '⚠ Chiudi' : '✏️ Correggi'}
            </button>
          )}
          <button onClick={() => setExpanded(!expanded)}
                  className="px-2.5 py-1 rounded font-mono text-xxs text-text-secondary hover:text-text-primary border border-bg-border">
            {expanded ? '▲ Hide' : '▼ Detail'}
          </button>
          <button onClick={onDelete}
                  className="px-2.5 py-1 rounded font-mono text-xxs text-red/60 hover:text-red border border-bg-border">
            🗑
          </button>
        </div>
      </div>

      {/* Modal: correzione outcome manuale */}
      {correctOpen && (
        <CorrectOutcomeModal
          decision={d}
          onClose={() => setCorrectOpen(false)}
          onSubmit={(correction) => {
            onCorrect(correction)
            setCorrectOpen(false)
          }}
        />
      )}

      {expanded && (
        <div className="border-t border-bg-border bg-bg-primary/40 p-3 space-y-3">
          {/* Original decision details */}
          <div>
            <div className="font-mono text-xxs text-text-muted uppercase tracking-wider mb-1">
              Decisione originale
            </div>
            <div className="font-mono text-xs text-text-primary grid grid-cols-3 gap-2">
              <span>Entry: <span className="text-text-secondary">{d.entryPrice}</span></span>
              <span>SL: <span className="text-text-secondary">{d.suggestedSL ?? '—'}</span></span>
              <span>TP: <span className="text-text-secondary">{d.suggestedTP ?? '—'}</span></span>
            </div>
            {d.reasons?.length > 0 && (
              <div className="font-mono text-xxs text-text-muted mt-1.5 italic line-clamp-2">
                {d.reasons.map(r => r.label || r.detail).filter(Boolean).join(' · ')}
              </div>
            )}
          </div>

          {/* Review details */}
          {r ? (
            <div className="border-t border-bg-border pt-3 space-y-2">
              <div className="font-mono text-xxs text-text-muted uppercase tracking-wider">
                Post-mortem Claude · rivisto {new Date(reviewedAt).toLocaleString('it-IT', { day: '2-digit', month: 'short', hour: '2-digit' })}
              </div>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
                {r.what_went_right?.length > 0 && (
                  <div className="bg-green/5 rounded p-2 border border-green/20">
                    <div className="font-mono text-xxs text-green font-semibold mb-1">✓ Cosa ho fatto bene</div>
                    <ul className="space-y-0.5">
                      {r.what_went_right.map((x, i) => (
                        <li key={i} className="font-mono text-xxs text-text-primary">▸ {x}</li>
                      ))}
                    </ul>
                  </div>
                )}
                {r.what_went_wrong?.length > 0 && (
                  <div className="bg-red/5 rounded p-2 border border-red/20">
                    <div className="font-mono text-xxs text-red font-semibold mb-1">✗ Cosa ho sbagliato</div>
                    <ul className="space-y-0.5">
                      {r.what_went_wrong.map((x, i) => (
                        <li key={i} className="font-mono text-xxs text-text-primary">▸ {x}</li>
                      ))}
                    </ul>
                  </div>
                )}
              </div>
              {r.lessons?.length > 0 && (
                <div className="bg-purple-500/5 rounded p-2 border border-purple-500/20">
                  <div className="font-mono text-xxs text-purple-300 font-semibold mb-1">🧠 Lezioni</div>
                  <ul className="space-y-1">
                    {r.lessons.map((l, i) => (
                      <li key={i} className="font-mono text-xxs text-text-primary">
                        <span className="text-purple-300/60">[{l.tag}]</span> {l.italian}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              <div className="flex gap-3 text-xxs font-mono text-text-muted pt-1">
                <span>Confidence: <span style={{
                  color: r.confidence_calibration === 'overconfident' ? '#ff3355'
                       : r.confidence_calibration === 'underconfident' ? '#f5c842'
                       : '#00e096'
                }}>{r.confidence_calibration}</span></span>
                <span>Rifareibe? <span className={r.would_redo_same ? 'text-green' : 'text-red'}>{r.would_redo_same ? 'Sì' : 'No'}</span></span>
              </div>
              {r.calibration_note && (
                <div className="font-mono text-xxs text-text-secondary italic">{r.calibration_note}</div>
              )}
            </div>
          ) : (
            <div className="font-mono text-xxs text-text-muted italic">
              Non ancora rivista. Clicca "🔍 Review" per farla analizzare con il senno di poi.
            </div>
          )}
        </div>
      )}
    </div>
  )
}

function ReportSummary({ report }) {
  if (!report) {
    return (
      <div className="bg-bg-primary rounded-lg border border-bg-border p-4 mb-3">
        <div className="font-mono text-xs text-text-muted text-center py-3">
          Nessuna review ancora. Esegui "Review ultime 10/20" per generare il report.
        </div>
      </div>
    )
  }
  const acc = report.accuracy_pct
  const accColor = acc >= 60 ? '#00e096' : acc >= 40 ? '#f5c842' : '#ff3355'
  return (
    <div className="bg-bg-primary rounded-lg border border-bg-border p-4 mb-3">
      <div className="font-mono text-xs text-gold font-semibold uppercase tracking-wider mb-3">
        📊 Report aggregato
      </div>
      <div className="text-center mb-3">
        <div className="font-mono text-xxs text-text-muted uppercase">Accuracy</div>
        <div className="font-mono text-4xl font-bold tabular-nums" style={{ color: accColor }}>{acc}%</div>
        <div className="font-mono text-xxs text-text-muted">{report.total_reviews} review</div>
      </div>
      <div className="grid grid-cols-3 gap-1.5 mb-3">
        <Mini label="Right"  value={report.right}  color="#00e096" />
        <Mini label="Wrong"  value={report.wrong}  color="#ff3355" />
        <Mini label="Mixed"  value={report.mixed}  color="#f5c842" />
      </div>
      <div className="font-mono text-xxs text-text-muted uppercase tracking-wider mb-1.5 mt-3">
        Calibration confidence
      </div>
      <div className="font-mono text-xs text-text-primary mb-3">
        Dominante: <span className="font-semibold" style={{
          color: report.confidence_calibration.dominant === 'overconfident' ? '#ff3355'
               : report.confidence_calibration.dominant === 'underconfident' ? '#f5c842'
               : '#00e096'
        }}>{report.confidence_calibration.dominant}</span>
        <span className="text-text-muted ml-2">
          (over {report.confidence_calibration.overconfident} ·
          under {report.confidence_calibration.underconfident} ·
          ok {report.confidence_calibration.well_calibrated})
        </span>
      </div>
      {report.top_lessons.length > 0 && (
        <>
          <div className="font-mono text-xxs text-text-muted uppercase tracking-wider mb-1.5 mt-3">
            Top lezioni (per ricorrenza)
          </div>
          <div className="space-y-1">
            {report.top_lessons.slice(0, 5).map((l, i) => (
              <div key={l.tag} className="bg-bg-secondary rounded p-2 border border-bg-border/50">
                <div className="flex items-center justify-between">
                  <span className="font-mono text-xxs text-purple-300">[{l.tag}]</span>
                  <span className="font-mono text-xxs text-text-muted">×{l.count}</span>
                </div>
                <div className="font-mono text-xxs text-text-primary mt-0.5 leading-relaxed">
                  {l.italian}
                </div>
              </div>
            ))}
          </div>
        </>
      )}
      {Object.keys(report.by_symbol).length > 0 && (
        <>
          <div className="font-mono text-xxs text-text-muted uppercase tracking-wider mb-1.5 mt-3">
            Per simbolo
          </div>
          <div className="space-y-0.5">
            {Object.entries(report.by_symbol).sort((a, b) => b[1].total - a[1].total).map(([sym, s]) => (
              <div key={sym} className="flex justify-between font-mono text-xxs">
                <span className="text-text-primary">{sym}</span>
                <span className="text-text-muted">{s.right}/{s.total} {s.total > 0 ? `(${Math.round(s.right/s.total*100)}%)` : ''}</span>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  )
}

function LessonsBox({ lessons, onClear }) {
  if (!lessons) {
    return (
      <div className="bg-bg-primary rounded-lg border border-bg-border p-4">
        <div className="font-mono text-xs text-text-muted uppercase tracking-wider mb-2">
          🧠 Lezioni iniettate nel prompt
        </div>
        <div className="font-mono text-xxs text-text-muted italic leading-relaxed">
          Nessuna lezione attiva. Clicca "🧠 Genera lezioni → prompt" sopra per estrarre le top
          lezioni dalle review e iniettarle automaticamente nel prompt delle prossime analisi.
        </div>
      </div>
    )
  }
  return (
    <div className="bg-purple-500/5 rounded-lg border border-purple-500/30 p-4">
      <div className="flex justify-between items-center mb-2">
        <div className="font-mono text-xs text-purple-300 uppercase tracking-wider font-semibold">
          🧠 Lezioni attive nel prompt
        </div>
        <button onClick={onClear} title="Rimuovi tutte le lezioni dal prompt"
                className="font-mono text-xxs text-text-muted hover:text-red">🗑</button>
      </div>
      <div className="font-mono text-xxs text-text-muted mb-2">
        Calibration: <span className="text-purple-300">{lessons.calibration}</span> · {lessons.stats_note}
      </div>
      <ol className="space-y-1.5">
        {lessons.lessons.map((l, i) => (
          <li key={i} className="font-mono text-xs text-text-primary flex gap-2 leading-relaxed">
            <span className="text-purple-300 shrink-0 font-bold">{i + 1}.</span>
            <span>{l}</span>
          </li>
        ))}
      </ol>
      <div className="font-mono text-xxs text-text-muted mt-3 pt-2 border-t border-purple-500/20 italic">
        Queste lezioni vengono iniettate nel SYSTEM_PROMPT di ogni nuova analisi Claude.
        Claude le citerà esplicitamente in "reasoning" quando si applicano.
      </div>
      <div className="font-mono text-xxs text-text-muted mt-1">
        Aggiornato: {new Date(lessons.updated_at).toLocaleString('it-IT')}
      </div>
    </div>
  )
}

// ─── Modal: correzione outcome manuale ──────────────────────────────
function CorrectOutcomeModal({ decision, onClose, onSubmit }) {
  const d = decision
  const [exitPrice, setExitPrice] = useState(d.exitPrice ?? '')
  const [result, setResult]       = useState('')   // 'WIN' | 'LOSS' | 'BE' | ''
  const [notes, setNotes]         = useState('')

  // Auto-suggest exit price quando seleziona result
  const onResultChange = (r) => {
    setResult(r)
    if (r === 'WIN' && d.suggestedTP != null)  setExitPrice(d.suggestedTP)
    if (r === 'LOSS' && d.suggestedSL != null) setExitPrice(d.suggestedSL)
    if (r === 'BE')                             setExitPrice(d.entryPrice)
  }

  // Calcolo preview
  const exitNum = parseFloat(exitPrice)
  const validExit = !isNaN(exitNum)
  const sign = d.direction === 'LONG' ? 1 : -1
  const previewPnl = validExit ? sign * (exitNum - d.entryPrice) : null
  const previewPnlPct = (previewPnl != null && d.entryPrice) ? (previewPnl / d.entryPrice) * 100 : null
  const risk = d.suggestedSL != null ? Math.abs(d.entryPrice - d.suggestedSL) : null
  const previewR = (previewPnl != null && risk > 0) ? previewPnl / risk : null

  const submit = () => {
    if (!validExit) return alert('Inserisci un exit price valido')
    onSubmit({ exitPrice: exitNum, result: result || null, notes })
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70" onClick={onClose}>
      <div className="bg-bg-secondary border-2 border-orange-500/50 rounded-xl p-5 w-full max-w-md" onClick={e => e.stopPropagation()}>
        <h3 className="font-mono text-base text-orange-300 font-bold mb-3">
          {d.status === 'open' ? '⚠ Chiudi manualmente' : '✏️ Correggi outcome'}
        </h3>
        <p className="font-mono text-xxs text-text-muted mb-4 leading-relaxed">
          {d.status === 'open'
            ? 'Il trade è ancora aperto nel sistema ma sul broker è già stato chiuso (es. SL/TP hit non rilevato per lag Yahoo). Inserisci exit price reale per chiuderlo.'
            : 'Usa questo se il sistema (basato su candele Yahoo) ha rilevato un outcome diverso da quello reale del broker (es. lag, divergenza intra-bar, slippage).'}
          {' '}Il record viene marcato come <span className="text-orange-300">MANUAL</span>.
        </p>

        <div className="space-y-3">
          <div>
            <div className="font-mono text-xxs text-text-muted uppercase mb-1">Risultato reale</div>
            <div className="grid grid-cols-3 gap-1.5">
              {['WIN', 'LOSS', 'BE'].map(r => (
                <button key={r} onClick={() => onResultChange(r)}
                        className={`px-3 py-2 rounded font-mono text-sm font-bold border ${
                          result === r
                            ? r === 'WIN' ? 'bg-green/20 text-green border-green'
                              : r === 'LOSS' ? 'bg-red/20 text-red border-red'
                              : 'bg-gold/20 text-gold border-gold'
                            : 'bg-bg-primary text-text-secondary border-bg-border hover:border-text-secondary'
                        }`}>
                  {r}
                </button>
              ))}
            </div>
            <div className="font-mono text-xxs text-text-muted mt-1">
              Seleziona per auto-popolare exit price (TP/SL/Entry).
            </div>
          </div>

          <div>
            <label className="font-mono text-xxs text-text-muted uppercase block mb-1">Exit price reale broker</label>
            <input type="number" step="0.01" value={exitPrice}
                   onChange={e => setExitPrice(e.target.value)}
                   placeholder={`Es: ${d.entryPrice}`}
                   className="w-full bg-bg-primary border border-bg-border rounded px-3 py-2 font-mono text-sm text-text-primary" />
          </div>

          <div>
            <label className="font-mono text-xxs text-text-muted uppercase block mb-1">Note (opzionale)</label>
            <input type="text" value={notes}
                   onChange={e => setNotes(e.target.value)}
                   placeholder="Es: SL hit per spread, gap, slippage..."
                   className="w-full bg-bg-primary border border-bg-border rounded px-3 py-2 font-mono text-sm text-text-primary" />
          </div>

          {validExit && (
            <div className="bg-bg-primary rounded p-3 border border-bg-border">
              <div className="font-mono text-xxs text-text-muted uppercase mb-1.5">Preview</div>
              <div className="grid grid-cols-3 gap-2 font-mono text-xs">
                <div>
                  <div className="text-text-muted">P&L</div>
                  <div className={`font-bold ${previewPnl >= 0 ? 'text-green' : 'text-red'}`}>
                    {previewPnl >= 0 ? '+' : ''}{previewPnl?.toFixed(2)}
                  </div>
                </div>
                <div>
                  <div className="text-text-muted">P&L %</div>
                  <div className={`font-bold ${previewPnlPct >= 0 ? 'text-green' : 'text-red'}`}>
                    {previewPnlPct >= 0 ? '+' : ''}{previewPnlPct?.toFixed(3)}%
                  </div>
                </div>
                <div>
                  <div className="text-text-muted">R-multiple</div>
                  <div className={`font-bold ${previewR >= 0 ? 'text-green' : 'text-red'}`}>
                    {previewR >= 0 ? '+' : ''}{previewR?.toFixed(2)}R
                  </div>
                </div>
              </div>
            </div>
          )}

          <div className="font-mono text-xxs text-text-muted bg-bg-primary/50 rounded p-2 border border-bg-border/50">
            <div>Entry originale: <span className="text-text-primary">{d.entryPrice}</span></div>
            <div>SL: <span className="text-red">{d.suggestedSL ?? '—'}</span> · TP: <span className="text-green">{d.suggestedTP ?? '—'}</span></div>
            <div>Sistema vedeva exit: <span className="text-text-primary">{d.exitPrice ?? '—'}</span></div>
          </div>
        </div>

        <div className="flex gap-2 mt-4">
          <button onClick={onClose}
                  className="flex-1 px-4 py-2 rounded font-mono text-sm text-text-secondary border border-bg-border hover:bg-bg-hover">
            Annulla
          </button>
          <button onClick={submit} disabled={!validExit}
                  className="flex-1 px-4 py-2 rounded font-mono text-sm font-semibold bg-orange-500/20 text-orange-300 border border-orange-500/50 hover:bg-orange-500/30 disabled:opacity-50">
            Salva correzione
          </button>
        </div>
      </div>
    </div>
  )
}

function Mini({ label, value, color }) {
  return (
    <div className="bg-bg-secondary rounded p-1.5 text-center border border-bg-border">
      <div className="font-mono text-xxs text-text-muted uppercase tracking-wider">{label}</div>
      <div className="font-mono text-base font-bold tabular-nums" style={{ color }}>{value}</div>
    </div>
  )
}
