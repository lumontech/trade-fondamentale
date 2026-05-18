import { useMemo, useState, useEffect } from 'react'
import { useAppStore } from '../store/store'
import { calculateCorrelationMatrix } from '../services/CorrelationEngine'
import { loadCandles } from '../services/DataHub'

// Colore della cella: rosso forte = +1, blu forte = -1, grigio = 0
function corrColor(c) {
  if (c == null) return '#1e2535'
  const intensity = Math.min(1, Math.abs(c))
  if (c > 0) {
    // Verde sempre più intenso
    const alpha = Math.round(intensity * 200).toString(16).padStart(2, '0')
    return `#00e096${alpha}`
  } else {
    const alpha = Math.round(intensity * 200).toString(16).padStart(2, '0')
    return `#ff3355${alpha}`
  }
}

function corrText(c) {
  if (c == null) return '—'
  return c.toFixed(2)
}

export default function CorrelationPanel() {
  const instruments = useAppStore(s => s.instruments)
  const setPanel    = useAppStore(s => s.setActivePanel)
  const [loading, setLoading] = useState({ active: false, current: 0, total: 0, currentSym: '' })

  // Strumenti che NON hanno candele caricate (>20 candele necessarie per la correlation)
  const missing = Object.entries(instruments)
    .filter(([sym, inst]) => !inst.candles || inst.candles.length < 20)
    .map(([sym]) => sym)
  const loaded = Object.keys(instruments).length - missing.length

  // Auto-load missing al primo mount (passive: non aspetta ma trigger)
  useEffect(() => {
    if (missing.length === 0 || loading.active) return
    const loadAll = async () => {
      setLoading({ active: true, current: 0, total: missing.length, currentSym: missing[0] })
      for (let i = 0; i < missing.length; i++) {
        const sym = missing[i]
        setLoading({ active: true, current: i + 1, total: missing.length, currentSym: sym })
        try { await loadCandles(sym, '1h') } catch {}
      }
      setLoading({ active: false, current: 0, total: 0, currentSym: '' })
    }
    loadAll()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const { symbols, matrix } = useMemo(() =>
    calculateCorrelationMatrix(instruments, 100),
    [instruments]
  )

  return (
    <div className="h-full flex flex-col bg-bg-primary overflow-hidden">

      <div className="flex items-center justify-between px-6 py-4 border-b border-bg-border bg-bg-secondary shrink-0">
        <div>
          <h2 className="font-mono text-xl font-semibold text-gold tracking-wider">
            🔗 MATRICE CORRELAZIONI
          </h2>
          <p className="font-mono text-sm text-text-secondary mt-0.5">
            Pearson correlation sui log-returns delle ultime 100 candele.
            Verde = movimento stesso verso · Rosso = inverso · Più scuro = più forte.
          </p>
        </div>
        <div className="flex items-center gap-3">
          <span className="font-mono text-xs text-text-muted">
            {loaded}/{Object.keys(instruments).length} strumenti caricati
          </span>
          <button
            onClick={() => setPanel('chart')}
            className="font-mono text-sm text-text-secondary hover:text-text-primary px-4 py-2 hover:bg-bg-hover rounded-md border border-bg-border"
          >
            ✕ Chiudi
          </button>
        </div>
      </div>

      {loading.active && (
        <div className="px-6 py-3 bg-gold/10 border-b border-gold/30 flex items-center gap-3">
          <span className="inline-block w-2 h-2 rounded-full bg-gold animate-ping" />
          <span className="font-mono text-sm text-gold">
            Caricamento candele {loading.current}/{loading.total} — {loading.currentSym}
          </span>
          <div className="flex-1 h-1.5 bg-bg-primary rounded-full overflow-hidden">
            <div className="h-full bg-gold transition-all"
                 style={{ width: `${(loading.current / loading.total) * 100}%` }} />
          </div>
        </div>
      )}

      <div className="flex-1 overflow-auto p-6">
        {symbols.length < 2 ? (
          <div className="text-center py-20">
            <div className="font-mono text-base text-text-muted">
              ⏳ Servono almeno 2 strumenti con candele caricate.
            </div>
            <div className="font-mono text-xs text-text-muted mt-2">
              Apri qualche strumento dalla watchlist per popolare la matrice.
            </div>
          </div>
        ) : (
          <div className="inline-block bg-bg-secondary rounded-xl border border-bg-border p-4">
            <table className="font-mono text-xs">
              <thead>
                <tr>
                  <th className="px-2 py-1"></th>
                  {symbols.map(s => (
                    <th key={s} className="px-2 py-1 text-text-muted text-center min-w-[68px]">
                      {s}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {symbols.map(s1 => (
                  <tr key={s1}>
                    <td className="px-2 py-1 text-gold font-semibold">{s1}</td>
                    {symbols.map(s2 => {
                      const c = matrix[s1][s2]
                      const isDiagonal = s1 === s2
                      return (
                        <td key={s2}
                            className="px-2 py-1 text-center tabular-nums font-semibold rounded"
                            style={{
                              backgroundColor: isDiagonal ? '#f5c84230' : corrColor(c),
                              color: isDiagonal ? '#f5c842' :
                                     c != null && Math.abs(c) > 0.4 ? '#04060a' : '#e5e7eb',
                              minWidth: '60px',
                            }}>
                          {corrText(c)}
                        </td>
                      )
                    })}
                  </tr>
                ))}
              </tbody>
            </table>

            <div className="mt-6 pt-4 border-t border-bg-border">
              <div className="font-mono text-xs text-text-muted mb-2 uppercase tracking-wider">
                Come leggere
              </div>
              <ul className="space-y-1 text-xs font-mono text-text-secondary">
                <li>• <span className="text-green">+0.7…+1.0</span> — correlazione fortissima positiva (muovono insieme)</li>
                <li>• <span className="text-text-primary">+0.3…+0.7</span> — moderata positiva</li>
                <li>• <span className="text-text-muted">−0.3…+0.3</span> — debole o assente</li>
                <li>• <span className="text-red">−0.7…−1.0</span> — correlazione fortissima negativa (muovono opposti)</li>
              </ul>
              <p className="font-mono text-xs text-text-muted mt-3 leading-relaxed">
                Usa la matrice per cross-confermare un trade: se sei LONG su EURUSD ma DXY (correlato −0.9) sta salendo, hai una divergenza.
                Se entri su trade altamente correlati, ricorda che è una sola scommessa, non due.
              </p>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
