import { useEffect, useState, useMemo } from 'react'
import { SESSIONS, FX_OVERLAPS, getSessionStatus, fmtDuration, fmtLocalFromUTC } from '../services/MarketSessions'

export default function MarketSessionsBar() {
  const [now, setNow] = useState(() => new Date())

  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 60_000)
    return () => clearInterval(id)
  }, [])

  const items = useMemo(() => SESSIONS.map(s => ({
    ...s,
    status: getSessionStatus(s, now),
  })), [now])

  const overlap = useMemo(() => {
    const m = now.getUTCHours() * 60 + now.getUTCMinutes()
    const day = now.getUTCDay()
    if (day === 0 || day === 6) return null
    for (const ov of FX_OVERLAPS) {
      if (m >= ov.openUTC && m < ov.closeUTC) return ov
    }
    return null
  }, [now])

  return (
    <div className="flex items-center gap-3 px-4 py-1.5 bg-bg-secondary border-b border-bg-border overflow-x-auto">
      <span className="font-mono text-xxs text-gold uppercase tracking-widest mr-1 shrink-0">
        SESSIONI
      </span>

      {items.map(it => {
        const open = it.status.open
        const isAlways = it.weekend === 'always'
        const dotColor  = isAlways ? '#f5c842' : open ? '#00e096' : '#3a4258'
        const tip = open
          ? `${it.label} APERTO • Chiude ${fmtLocalFromUTC(it.closeUTC, now)} (tra ${fmtDuration(it.status.closesIn)})`
          : `${it.label} CHIUSO • Apre ${fmtLocalFromUTC(it.openUTC, now)} (tra ${fmtDuration(it.status.opensIn)})`
        return (
          <div key={it.id}
               className="flex items-center gap-1.5 shrink-0"
               title={tip}>
            <span className="w-1.5 h-1.5 rounded-full inline-block"
                  style={{ backgroundColor: dotColor,
                           boxShadow: open && !isAlways ? `0 0 6px ${dotColor}99` : 'none' }} />
            <span className={`font-mono text-xs ${open ? 'text-text-primary' : 'text-text-muted'}`}>
              <span className="mr-0.5">{it.flag}</span>{it.label}
            </span>
            {open && !isAlways && (
              <span className="font-mono text-xxs text-text-muted tabular-nums">
                ↓{fmtDuration(it.status.closesIn)}
              </span>
            )}
          </div>
        )
      })}

      {overlap && (
        <div className="ml-auto flex items-center gap-2 px-2.5 py-0.5 rounded-md shrink-0
                        bg-gold/10 border border-gold/40 animate-[pulse-soft_3s_ease-in-out_infinite]">
          <span className="text-gold leading-none">⚡</span>
          <span className="font-mono text-xs font-semibold text-gold">{overlap.label}</span>
          <span className="font-mono text-xxs text-text-secondary hidden md:inline">{overlap.note}</span>
        </div>
      )}
    </div>
  )
}
