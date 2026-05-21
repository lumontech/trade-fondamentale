import { useState, useMemo } from 'react'
import { useAppStore } from '../store/store'
import { getAllDecisions, closeDecision, dismissDecision, deleteDecision, getStats } from '../services/TradeLog'
import { useToast } from './ui/Toast'
import { useConfirm, usePromptNumber } from './ui/Modal'

const DIR_STYLE = {
  LONG:  { color: '#00e096', icon: '▲' },
  SHORT: { color: '#ff3355', icon: '▼' },
  FLAT:  { color: '#f5c842', icon: '■' },
}

export default function TradeLogPanel() {
  const setPanel     = useAppStore(s => s.setActivePanel)
  const instruments  = useAppStore(s => s.instruments)
  const toast        = useToast()
  const { confirm, ConfirmDialog } = useConfirm()
  const { promptNumber, PromptDialog } = usePromptNumber()
  const [tick, setTick] = useState(0)
  const refresh = () => setTick(n => n + 1)

  // eslint-disable-next-line react-hooks/exhaustive-deps
  const decisions = useMemo(() => getAllDecisions(), [tick])
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const stats     = useMemo(() => getStats(), [tick])

  const handleClose = async (d) => {
    const livePrice = instruments[d.symbol]?.price ?? d.entryPrice
    const result = await promptNumber({
      title:    `Chiudi ${d.direction} su ${d.symbol}`,
      message:  `Inserisci il prezzo di chiusura. Entry registrato: ${d.entryPrice}`,
      subtext:  `Prezzo live al momento: ${livePrice}`,
      label:    'Prezzo di chiusura',
      defaultValue: livePrice,
      allowNotes: true,
      confirmText: '✓ Chiudi posizione',
    })
    if (!result) return
    closeDecision(d.id, result.value, result.notes)
    refresh()
    const pnl = (d.direction === 'LONG' ? 1 : -1) * (result.value - d.entryPrice)
    toast.success(
      `${d.symbol} ${d.direction} chiuso a ${result.value} (${pnl > 0 ? '+' : ''}${pnl.toFixed(5)})`,
      { title: pnl > 0 ? '🎯 Win registrato' : pnl < 0 ? '🛑 Loss registrato' : 'Decisione chiusa' }
    )
  }
  const handleDismiss = async (d) => {
    const ok = await confirm({
      title: 'Scartare la decisione?',
      message: `Vuoi scartare la decisione ${d.direction} su ${d.symbol}? Non verrà conteggiata nelle statistiche.`,
      confirmText: 'Scarta',
    })
    if (!ok) return
    dismissDecision(d.id, '')
    refresh()
    toast.info(`Decisione su ${d.symbol} scartata`)
  }
  const handleDelete = async (d) => {
    const ok = await confirm({
      title: 'Elimina definitivamente?',
      message: `Questa azione non può essere annullata. Eliminare la decisione ${d.direction} su ${d.symbol}?`,
      confirmText: 'Elimina',
      danger: true,
    })
    if (!ok) return
    deleteDecision(d.id)
    refresh()
    toast.warning('Decisione eliminata definitivamente')
  }

  const open    = decisions.filter(d => d.status === 'open')
  const closed  = decisions.filter(d => d.status === 'closed')
  const dropped = decisions.filter(d => d.status === 'dismissed')

  return (
    <div className="h-full flex flex-col bg-bg-primary overflow-hidden">

      <ConfirmDialog />
      <PromptDialog />

      <div className="flex items-center justify-between px-6 py-4 border-b border-bg-border bg-bg-secondary shrink-0">
        <div>
          <h2 className="font-mono text-xl font-semibold text-gold tracking-wider">
            📋 STORIA DECISIONI
          </h2>
          <p className="font-mono text-sm text-text-secondary mt-0.5">
            Vista tabellare di TUTTE le decisioni Claude (auto-loggate). Per chiudere i trade o gestire lezioni vai in <span className="text-purple-300">🧪 Review & Lessons</span>.
          </p>
        </div>
        <button
          onClick={() => setPanel('chart')}
          className="font-mono text-sm text-text-secondary hover:text-text-primary px-4 py-2 hover:bg-bg-hover rounded-md border border-bg-border"
        >
          ✕ Chiudi
        </button>
      </div>

      <div className="flex-1 overflow-y-auto p-6 space-y-5">

        {/* Stats globali */}
        {stats && (
          <div className="bg-bg-secondary rounded-xl border border-bg-border p-5">
            <div className="font-mono text-sm text-gold mb-3 uppercase tracking-wider">PERFORMANCE GLOBALE</div>
            <div className="grid grid-cols-3 md:grid-cols-6 gap-4">
              <Stat label="Trade chiusi" value={stats.total} />
              <Stat label="Win" value={stats.wins} color="#00e096" />
              <Stat label="Loss" value={stats.losses} color="#ff3355" />
              <Stat label="Win Rate" value={(stats.winRate * 100).toFixed(0) + '%'}
                    color={stats.winRate >= 0.55 ? '#00e096' : stats.winRate < 0.45 ? '#ff3355' : '#f5c842'} />
              <Stat label="R medio" value={stats.avgR.toFixed(2)}
                    color={stats.avgR >= 0 ? '#00e096' : '#ff3355'} />
              <Stat label="Profit Factor" value={isFinite(stats.profitFactor) ? stats.profitFactor.toFixed(2) : '∞'}
                    color={stats.profitFactor >= 1.5 ? '#00e096' : stats.profitFactor < 1 ? '#ff3355' : '#f5c842'} />
            </div>

            {/* Calibrazione */}
            <div className="mt-5 pt-4 border-t border-bg-border">
              <div className="font-mono text-xs text-text-muted uppercase tracking-wider mb-2">
                Calibrazione confidence
              </div>
              <div className="grid grid-cols-3 gap-3">
                {stats.calibration.map(b => (
                  <div key={b.label} className="bg-bg-primary rounded-md px-3 py-2">
                    <div className="font-mono text-xxs text-text-muted">Confidence {b.label}</div>
                    <div className="flex items-baseline justify-between">
                      <span className="font-mono text-sm text-text-primary">{b.count} trade</span>
                      <span className="font-mono text-base tabular-nums font-semibold"
                            style={{ color: b.winRate == null ? '#8892a4'
                                          : b.winRate >= 0.6 ? '#00e096'
                                          : b.winRate < 0.4  ? '#ff3355' : '#f5c842' }}>
                        {b.winRate != null ? (b.winRate * 100).toFixed(0) + '%' : '—'}
                      </span>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}

        {/* Decisioni aperte */}
        <Section title={`APERTE (${open.length})`} color="#f5c842">
          {open.length === 0 ? (
            <Empty msg="Nessuna decisione aperta. Salva una raccomandazione dal pannello DECISIONE OPERATIVA." />
          ) : (
            open.map(d => (
              <DecisionRow key={d.id} d={d} live={instruments[d.symbol]?.price}
                           onClose={handleClose} onDismiss={handleDismiss} onDelete={handleDelete} />
            ))
          )}
        </Section>

        {/* Decisioni chiuse */}
        <Section title={`CHIUSE (${closed.length})`} color="#00e096">
          {closed.length === 0 ? (
            <Empty msg="Nessuna decisione chiusa." />
          ) : (
            closed.map(d => (
              <DecisionRow key={d.id} d={d} onDelete={handleDelete} />
            ))
          )}
        </Section>

        {dropped.length > 0 && (
          <Section title={`SCARTATE (${dropped.length})`} color="#8892a4">
            {dropped.map(d => (
              <DecisionRow key={d.id} d={d} onDelete={handleDelete} />
            ))}
          </Section>
        )}
      </div>
    </div>
  )
}

function Section({ title, color, children }) {
  return (
    <div>
      <div className="font-mono text-sm font-semibold uppercase tracking-wider mb-2 px-1"
           style={{ color }}>
        {title}
      </div>
      <div className="space-y-2">{children}</div>
    </div>
  )
}

function Empty({ msg }) {
  return (
    <div className="bg-bg-secondary rounded-xl border border-bg-border p-5 text-center">
      <span className="font-mono text-sm text-text-muted">{msg}</span>
    </div>
  )
}

function DecisionRow({ d, live, onClose, onDismiss, onDelete }) {
  const dirStyle = DIR_STYLE[d.direction]
  const isOpen   = d.status === 'open'
  const isClosed = d.status === 'closed'

  // P/L live se aperto
  let livePnl = null
  let livePnlPct = null
  if (isOpen && live != null) {
    const sign = d.direction === 'LONG' ? 1 : -1
    livePnl = sign * (live - d.entryPrice)
    livePnlPct = d.entryPrice !== 0 ? (livePnl / d.entryPrice) * 100 : null
  }

  return (
    <div className="bg-bg-secondary rounded-xl border border-bg-border p-4">
      <div className="grid grid-cols-[140px_120px_1fr_180px_180px_auto] gap-4 items-center">

        {/* Direzione + simbolo */}
        <div>
          <div className="flex items-center gap-2">
            <span className="font-mono text-lg font-bold" style={{ color: dirStyle.color }}>
              {dirStyle.icon} {d.direction}
            </span>
          </div>
          <div className="font-mono text-sm text-gold font-semibold mt-0.5">{d.symbol}</div>
          <div className="font-mono text-xxs text-text-muted">{d.timeframe}</div>
        </div>

        {/* Confidence + score */}
        <div>
          <div className="font-mono text-xxs text-text-muted uppercase">Confidence</div>
          <div className="font-mono text-lg tabular-nums" style={{ color: dirStyle.color }}>
            {d.confidence}%
          </div>
          <div className="font-mono text-xxs text-text-muted">
            T{d.techScore}·F{d.fundScore}·S{d.histScore}·X{d.crossScore}
          </div>
        </div>

        {/* Date / status */}
        <div>
          <div className="font-mono text-xxs text-text-muted uppercase">Aperta</div>
          <div className="font-mono text-xs text-text-primary tabular-nums">
            {new Date(d.openedAt).toLocaleString('it-IT', {
              day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit'
            })}
          </div>
          {isClosed && (
            <>
              <div className="font-mono text-xxs text-text-muted uppercase mt-1">Chiusa</div>
              <div className="font-mono text-xs text-text-primary tabular-nums">
                {new Date(d.closedAt).toLocaleString('it-IT', {
                  day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit'
                })}
              </div>
            </>
          )}
        </div>

        {/* Entry / Exit */}
        <div>
          <div className="font-mono text-xxs text-text-muted uppercase">Entry</div>
          <div className="font-mono text-sm tabular-nums">{d.entryPrice}</div>
          {isClosed && (
            <>
              <div className="font-mono text-xxs text-text-muted uppercase mt-1">Exit</div>
              <div className="font-mono text-sm tabular-nums">{d.exitPrice}</div>
            </>
          )}
          {isOpen && live != null && (
            <>
              <div className="font-mono text-xxs text-text-muted uppercase mt-1">Live</div>
              <div className="font-mono text-sm tabular-nums">{live.toFixed(5)}</div>
            </>
          )}
        </div>

        {/* P/L */}
        <div>
          {isClosed && (
            <>
              <div className="font-mono text-xxs text-text-muted uppercase">P/L</div>
              <div className="font-mono text-base font-semibold tabular-nums"
                   style={{ color: d.pnl > 0 ? '#00e096' : d.pnl < 0 ? '#ff3355' : '#8892a4' }}>
                {d.pnl > 0 ? '+' : ''}{d.pnl?.toFixed(5)}
                {d.pnlPct != null && (
                  <span className="text-xs ml-1">({d.pnlPct > 0 ? '+' : ''}{d.pnlPct.toFixed(2)}%)</span>
                )}
              </div>
              {d.rMultiple != null && (
                <div className="font-mono text-xs tabular-nums"
                     style={{ color: d.rMultiple > 0 ? '#00e096' : '#ff3355' }}>
                  {d.rMultiple > 0 ? '+' : ''}{d.rMultiple.toFixed(2)}R
                </div>
              )}
            </>
          )}
          {isOpen && livePnl != null && (
            <>
              <div className="font-mono text-xxs text-text-muted uppercase">P/L live</div>
              <div className="font-mono text-base font-semibold tabular-nums"
                   style={{ color: livePnl > 0 ? '#00e096' : livePnl < 0 ? '#ff3355' : '#8892a4' }}>
                {livePnl > 0 ? '+' : ''}{livePnl.toFixed(5)}
                {livePnlPct != null && (
                  <span className="text-xs ml-1">({livePnlPct > 0 ? '+' : ''}{livePnlPct.toFixed(2)}%)</span>
                )}
              </div>
            </>
          )}
        </div>

        {/* Actions */}
        <div className="flex gap-1">
          {isOpen && (
            <>
              <button onClick={() => onClose(d)}
                      className="px-2.5 py-1 rounded font-mono text-xs bg-green/10 text-green border border-green/30 hover:bg-green/20">
                ✓ Chiudi
              </button>
              <button onClick={() => onDismiss(d)}
                      className="px-2.5 py-1 rounded font-mono text-xs text-text-muted hover:text-text-primary border border-bg-border hover:bg-bg-hover">
                Scarta
              </button>
            </>
          )}
          <button onClick={() => onDelete(d)}
                  className="px-2 py-1 rounded font-mono text-xs text-red/70 hover:text-red border border-transparent hover:border-red/30">
            🗑
          </button>
        </div>
      </div>

      {/* Reasons & notes */}
      {(d.reasons?.length > 0 || d.notes) && (
        <div className="mt-3 pt-3 border-t border-bg-border">
          {d.reasons?.length > 0 && (
            <div className="flex flex-wrap gap-2 mb-2">
              {d.reasons.slice(0, 4).map((r, i) => (
                <span key={i} className="px-2 py-0.5 bg-bg-primary rounded text-xxs font-mono text-text-secondary">
                  {r.label}
                </span>
              ))}
            </div>
          )}
          {d.notes && (
            <div className="font-mono text-xs text-text-secondary italic">📝 {d.notes}</div>
          )}
        </div>
      )}
    </div>
  )
}

function Stat({ label, value, color = '#e5e7eb' }) {
  return (
    <div>
      <div className="font-mono text-xxs text-text-muted uppercase tracking-wider">{label}</div>
      <div className="font-mono text-xl font-semibold tabular-nums" style={{ color }}>{value}</div>
    </div>
  )
}
