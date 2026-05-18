import { useEffect, useState, useMemo } from 'react'
import { useAppStore } from '../store/store'
import { SESSIONS, FX_OVERLAPS, getSessionStatus, fmtDuration } from '../services/MarketSessions'

// Bar unica compatta: macro essenziali + sessione attiva + overlap
// Dettagli completi visibili al click "▾ dettagli"

export default function ContextBar() {
  const ctx = useAppStore(s => s.marketContext)
  const apiKeys = useAppStore(s => s.apiKeys)
  const fg = ctx.fearGreed
  const [now, setNow] = useState(() => new Date())
  const [expanded, setExpanded] = useState(false)

  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 60_000)
    return () => clearInterval(id)
  }, [])

  // Sessione principale attiva
  const sessionsState = useMemo(() => SESSIONS.map(s => ({ ...s, status: getSessionStatus(s, now) })), [now])
  const activeSessions = sessionsState.filter(s => s.status.open && s.weekend !== 'always')
  const overlap = useMemo(() => {
    const m = now.getUTCHours() * 60 + now.getUTCMinutes()
    const day = now.getUTCDay()
    if (day === 0 || day === 6) return null
    return FX_OVERLAPS.find(ov => m >= ov.openUTC && m < ov.closeUTC) || null
  }, [now])

  const fgColor = fg
    ? (fg.value < 25 ? '#ff3355' : fg.value < 45 ? '#ff7a8d' :
       fg.value < 55 ? '#f5c842' : fg.value < 75 ? '#7be0a3' : '#00e096')
    : '#8892a4'

  const hasFREDKey = !!apiKeys.fred

  return (
    <div className="bg-bg-secondary border-b border-bg-border">
      {/* Riga compatta sempre visibile */}
      <div className="flex items-center gap-3 px-4 py-1.5 overflow-x-auto">

        {/* Sessione attiva (1 sola, la più rilevante) */}
        <div className="flex items-center gap-2 shrink-0">
          {activeSessions.length > 0 ? (
            <>
              <span className="inline-block w-1.5 h-1.5 rounded-full bg-green animate-pulse"
                    style={{ boxShadow: '0 0 6px #00e09699' }} />
              <span className="font-mono text-xs text-text-primary">
                {activeSessions.map(s => `${s.flag} ${s.label}`).slice(0, 3).join(' · ')}
                {activeSessions.length > 3 && ` +${activeSessions.length - 3}`}
              </span>
            </>
          ) : (
            <>
              <span className="inline-block w-1.5 h-1.5 rounded-full bg-text-muted" />
              <span className="font-mono text-xs text-text-muted">Mercati chiusi</span>
            </>
          )}
        </div>

        {/* Overlap evidenziato */}
        {overlap && (
          <div className="flex items-center gap-1.5 px-2 py-0.5 rounded shrink-0
                          bg-gold/10 border border-gold/40 animate-[pulse-soft_3s_ease-in-out_infinite]">
            <span className="text-gold text-xs">⚡</span>
            <span className="font-mono text-xxs font-semibold text-gold">{overlap.label}</span>
          </div>
        )}

        <div className="w-px h-4 bg-bg-border shrink-0" />

        {/* Macro essenziali (4 chip) */}
        {ctx.us10y?.value != null && (
          <Chip label="US10Y" value={`${ctx.us10y.value.toFixed(2)}%`} change={ctx.us10y.changePct} />
        )}
        {ctx.vix?.value != null && (
          <Chip label="VIX" value={ctx.vix.value.toFixed(1)} change={ctx.vix.changePct}
                tooltip="VIX > 20 = mercato nervoso, < 14 = complacency" />
        )}
        {fg && (
          <div className="flex items-center gap-1.5 shrink-0" title={`Fear & Greed: ${fg.label} (${fg.value}/100)`}>
            <span className="font-mono text-xxs uppercase tracking-wider text-text-muted">F&G</span>
            <span className="font-mono text-xs font-semibold tabular-nums" style={{ color: fgColor }}>
              {fg.value}
            </span>
            <span className="font-mono text-xxs hidden md:inline" style={{ color: fgColor }}>{fg.label}</span>
          </div>
        )}
        {ctx.btcDominance != null && (
          <div className="flex items-center gap-1.5 shrink-0" title="BTC Dominance">
            <span className="font-mono text-xxs uppercase tracking-wider text-text-muted">BTC.D</span>
            <span className="font-mono text-xs tabular-nums text-text-primary font-semibold">
              {ctx.btcDominance.toFixed(1)}%
            </span>
          </div>
        )}

        {/* Avviso FRED key mancante */}
        {!hasFREDKey && (
          <span className="font-mono text-xxs text-text-muted ml-auto pr-1 shrink-0">
            ⚙ Aggiungi key FRED in API Hub per yields/VIX
          </span>
        )}

        {/* Toggle dettagli */}
        <button
          onClick={() => setExpanded(e => !e)}
          className="ml-auto font-mono text-xxs text-text-secondary hover:text-text-primary px-2 py-0.5 rounded hover:bg-bg-hover shrink-0"
          title="Mostra/nascondi dettagli sessioni e macro"
        >
          {expanded ? '▴ meno' : '▾ dettagli'}
        </button>
      </div>

      {/* Riga espansa con tutti i dettagli */}
      {expanded && (
        <div className="px-4 py-2 border-t border-bg-border/50 bg-bg-primary/30">
          {/* Sessioni complete */}
          <div className="flex items-center gap-3 overflow-x-auto mb-2">
            <span className="font-mono text-xxs text-gold uppercase tracking-widest shrink-0">SESSIONI</span>
            {sessionsState.map(s => {
              const open = s.status.open
              const isAlways = s.weekend === 'always'
              const dotColor = isAlways ? '#f5c842' : open ? '#00e096' : '#3a4258'
              return (
                <div key={s.id} className="flex items-center gap-1.5 shrink-0"
                     title={open ? `Chiude tra ${fmtDuration(s.status.closesIn)}` : `Apre tra ${fmtDuration(s.status.opensIn)}`}>
                  <span className="w-1.5 h-1.5 rounded-full inline-block" style={{ backgroundColor: dotColor }} />
                  <span className={`font-mono text-xxs ${open ? 'text-text-primary' : 'text-text-muted'}`}>
                    {s.flag} {s.label}
                  </span>
                </div>
              )
            })}
          </div>
          {/* Macro completo */}
          <div className="flex items-center gap-3 overflow-x-auto">
            <span className="font-mono text-xxs text-gold uppercase tracking-widest shrink-0">MACRO</span>
            <Chip label="US 10Y"  data={ctx.us10y} format="pct" />
            <Chip label="US 2Y"   data={ctx.us2y} format="pct" />
            <Chip label="10Y-2Y"  data={ctx.spread10y2y} format="pct" />
            <Chip label="VIX"     data={ctx.vix} format="idx" />
            <Chip label="DXY"     data={ctx.dxy} format="idx" />
          </div>
        </div>
      )}
    </div>
  )
}

function Chip({ label, value, change, data, format = 'pct', tooltip }) {
  // Supporta sia value/change espliciti, sia data oggetto {value, changePct}
  const v = data ? data.value : value
  const c = data ? data.changePct : change
  if (v == null) {
    return (
      <div className="flex items-center gap-1.5 shrink-0" title={tooltip || `${label} non disponibile`}>
        <span className="font-mono text-xxs uppercase tracking-wider text-text-muted">{label}</span>
        <span className="font-mono text-xxs text-text-muted">—</span>
      </div>
    )
  }
  const fmt = (n) => typeof n === 'string' ? n : format === 'pct' ? `${n.toFixed(2)}%` : n.toFixed(2)
  const dir = c > 0.01 ? 'up' : c < -0.01 ? 'down' : 'flat'
  const dirColor = dir === 'up' ? '#00e096' : dir === 'down' ? '#ff3355' : '#8892a4'
  return (
    <div className="flex items-center gap-1.5 shrink-0" title={tooltip || `${label}`}>
      <span className="font-mono text-xxs uppercase tracking-wider text-text-muted">{label}</span>
      <span className="font-mono text-xs tabular-nums text-text-primary font-semibold">{fmt(v)}</span>
      {c != null && dir !== 'flat' && (
        <span className="font-mono text-xxs tabular-nums" style={{ color: dirColor }}>
          {dir === 'up' ? '▲' : '▼'}{Math.abs(c).toFixed(1)}%
        </span>
      )}
    </div>
  )
}
