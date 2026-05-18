import { useAppStore } from '../store/store'
import { COT_CONTRACTS } from '../services/COTService'

const SENT_COLOR = {
  'MOLTO LONG':  '#00e096',
  'LONG':        '#7be0a3',
  'NEUTRO':      '#f5c842',
  'SHORT':       '#ff7a8d',
  'MOLTO SHORT': '#ff3355',
}

function PositionBar({ pctLong }) {
  const longPct = pctLong * 100
  const shortPct = 100 - longPct
  return (
    <div className="flex h-3 rounded-md overflow-hidden bg-bg-primary border border-bg-border min-w-[180px]">
      <div className="bg-green/70" style={{ width: `${longPct}%` }} />
      <div className="bg-red/70"   style={{ width: `${shortPct}%` }} />
    </div>
  )
}

export default function COTPanel() {
  const cotAll   = useAppStore(s => s.cot)
  const setPanel = useAppStore(s => s.setActivePanel)

  const symbols = Object.keys(COT_CONTRACTS).filter(s => COT_CONTRACTS[s])
  const hasData = symbols.some(s => cotAll[s])

  return (
    <div className="h-full flex flex-col bg-bg-primary overflow-hidden">

      <div className="flex items-center justify-between px-6 py-4 border-b border-bg-border bg-bg-secondary shrink-0">
        <div>
          <h2 className="font-mono text-xl font-semibold text-gold tracking-wider">
            🏛 COT REPORT — POSIZIONAMENTO ISTITUZIONALE
          </h2>
          <p className="font-mono text-sm text-text-secondary mt-0.5">
            CFTC Legacy Futures-Only — Non-Commercials (large speculators) vs Commercials (hedger).
            Pubblicato ogni venerdì 15:30 ET con dati al martedì.
          </p>
        </div>
        <button
          onClick={() => setPanel('chart')}
          className="font-mono text-sm text-text-secondary hover:text-text-primary px-4 py-2 hover:bg-bg-hover rounded-md border border-bg-border"
        >
          ✕ Chiudi
        </button>
      </div>

      <div className="flex-1 overflow-y-auto p-6">
        {!hasData ? (
          <div className="text-center py-20">
            <span className="font-mono text-base text-text-muted">⏳ Caricamento dati COT...</span>
          </div>
        ) : (
          <div className="space-y-3">
            {symbols.map(sym => {
              const cot = cotAll[sym]
              if (!cot) return null
              const sentColor = SENT_COLOR[cot.sentiment] || '#8892a4'
              const changeColor = cot.changePct == null ? '#8892a4'
                                : cot.changePct > 0 ? '#00e096' : '#ff3355'
              return (
                <div key={sym}
                     className="bg-bg-secondary rounded-xl border border-bg-border px-5 py-4
                                grid grid-cols-[120px_1fr_180px_140px_140px_120px] gap-4 items-center">
                  <div>
                    <div className="font-mono text-base font-semibold text-gold">{sym}</div>
                    <div className="font-mono text-xxs text-text-muted">{cot.contract}</div>
                  </div>

                  <div>
                    <div className="font-mono text-xxs text-text-muted uppercase tracking-wider mb-1">
                      Posizionamento Net Spec
                    </div>
                    <PositionBar pctLong={cot.ncPctLong} />
                    <div className="flex justify-between mt-1 font-mono text-xxs">
                      <span className="text-green">{(cot.ncPctLong * 100).toFixed(0)}% long</span>
                      <span className="text-red">{((1 - cot.ncPctLong) * 100).toFixed(0)}% short</span>
                    </div>
                  </div>

                  <div>
                    <div className="font-mono text-xxs text-text-muted uppercase tracking-wider">Sentiment</div>
                    <div className="font-mono text-base font-semibold" style={{ color: sentColor }}>
                      {cot.sentiment}
                    </div>
                  </div>

                  <div>
                    <div className="font-mono text-xxs text-text-muted uppercase tracking-wider">Net contratti</div>
                    <div className="font-mono text-sm tabular-nums text-text-primary">
                      {cot.netNc.toLocaleString()}
                    </div>
                  </div>

                  <div>
                    <div className="font-mono text-xxs text-text-muted uppercase tracking-wider">Δ settimana</div>
                    <div className="font-mono text-sm tabular-nums" style={{ color: changeColor }}>
                      {cot.change != null ? (cot.change > 0 ? '+' : '') + cot.change.toLocaleString() : '—'}
                      {cot.changePct != null && (
                        <span className="text-xxs ml-1">({cot.changePct > 0 ? '+' : ''}{cot.changePct.toFixed(1)}%)</span>
                      )}
                    </div>
                  </div>

                  <div className="text-right">
                    <div className="font-mono text-xxs text-text-muted uppercase tracking-wider">Report</div>
                    <div className="font-mono text-xs text-text-secondary tabular-nums">{cot.date}</div>
                  </div>
                </div>
              )
            })}
          </div>
        )}

        {/* Guida */}
        <div className="mt-6 bg-bg-secondary rounded-xl border border-bg-border p-5">
          <div className="font-mono text-sm font-medium text-gold mb-3">COME USARE IL COT</div>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4 font-mono text-xs text-text-secondary">
            <div>
              <div className="font-semibold text-text-primary mb-1">FOLLOW-THE-SMART-MONEY</div>
              I Non-Commercials sono fondi/CTA che muovono il mercato. Quando aumentano net long → trend rialzista, quando net short → trend ribassista.
            </div>
            <div>
              <div className="font-semibold text-text-primary mb-1">CONTRARIAN AGLI ESTREMI</div>
              Net spec long &gt;70% (crowded long) → mercato prossimo al top, possibile reversal short.
              Net spec short &lt;30% → possibile bottom, contrarian long.
            </div>
            <div>
              <div className="font-semibold text-text-primary mb-1">CAMBIO SETTIMANALE</div>
              Variazione veloce nello stesso senso del trend di prezzo conferma forza. Divergenza (prezzo su ma net spec giù) avverte di esaurimento.
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
