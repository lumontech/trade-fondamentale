// Sessioni dei mercati globali — orari espressi in UTC.
// La visualizzazione viene poi convertita automaticamente in ora italiana dal browser.

// Forex (24/5, chiuso da venerdì 21:00 UTC a domenica 22:00 UTC)
// Stocks: lun-ven, weekend chiusi
export const SESSIONS = [
  // ── Forex ────────────────────────────────────────────
  { id: 'sydney',   group: 'forex',  label: 'Sydney',     openUTC: 21*60,    closeUTC: 6*60,    weekend: 'fx', flag: '🇦🇺' },
  { id: 'tokyo',    group: 'forex',  label: 'Tokyo',      openUTC: 0*60,     closeUTC: 9*60,    weekend: 'fx', flag: '🇯🇵' },
  { id: 'london',   group: 'forex',  label: 'London',     openUTC: 7*60,     closeUTC: 16*60,   weekend: 'fx', flag: '🇬🇧' },
  { id: 'newyork',  group: 'forex',  label: 'New York',   openUTC: 12*60,    closeUTC: 21*60,   weekend: 'fx', flag: '🇺🇸' },

  // ── Stocks ───────────────────────────────────────────
  { id: 'nyse',     group: 'stocks', label: 'NYSE/NASDAQ',openUTC: 13*60+30, closeUTC: 20*60,   weekend: 'wk', flag: '🇺🇸' },
  { id: 'lse',      group: 'stocks', label: 'London LSE', openUTC: 7*60,     closeUTC: 15*60+30,weekend: 'wk', flag: '🇬🇧' },
  { id: 'xetra',    group: 'stocks', label: 'Frankfurt',  openUTC: 7*60,     closeUTC: 15*60+30,weekend: 'wk', flag: '🇩🇪' },
  { id: 'tse',      group: 'stocks', label: 'Tokyo TSE',  openUTC: 0*60,     closeUTC: 6*60,    weekend: 'wk', flag: '🇯🇵' },
  { id: 'hkex',     group: 'stocks', label: 'Hong Kong',  openUTC: 1*60+30,  closeUTC: 8*60,    weekend: 'wk', flag: '🇭🇰' },

  // ── Crypto sempre attivo ─────────────────────────────
  { id: 'crypto',   group: 'crypto', label: 'Crypto',     openUTC: 0,        closeUTC: 24*60,   weekend: 'always', flag: '₿' },
]

// Overlap forex notable (massima volatilità)
export const FX_OVERLAPS = [
  { id: 'london-ny',  label: 'London ↔ NY',     openUTC: 12*60, closeUTC: 16*60, note: 'Massima volatilità (overlap)' },
  { id: 'tokyo-london', label: 'Tokyo ↔ London',openUTC: 7*60,  closeUTC: 9*60,  note: 'Apertura Europa, momentum asia' },
]

// Restituisce minuti dalla mezzanotte UTC (current time)
function nowMinutesUTC(now = new Date()) {
  return now.getUTCHours() * 60 + now.getUTCMinutes()
}

// Restituisce status di una sessione: { open, opensIn, closesIn }
export function getSessionStatus(session, now = new Date()) {
  const day = now.getUTCDay()           // 0 = domenica, 6 = sabato
  const m   = nowMinutesUTC(now)
  const { openUTC, closeUTC, weekend } = session

  // Crypto sempre aperto
  if (weekend === 'always') return { open: true, opensIn: 0, closesIn: null, note: '24/7' }

  // Stocks: chiusi nel weekend
  if (weekend === 'wk' && (day === 0 || day === 6)) {
    return { open: false, opensIn: minutesToNextOpen(session, now), closesIn: null }
  }

  // Forex: chiuso da venerdì 21:00 UTC a domenica 22:00 UTC
  if (weekend === 'fx') {
    if (day === 6) return { open: false, opensIn: minutesToNextOpen(session, now), closesIn: null }
    if (day === 0 && m < 22*60) return { open: false, opensIn: (22*60 - m), closesIn: null }
    if (day === 5 && m >= 21*60) return { open: false, opensIn: minutesToNextOpen(session, now), closesIn: null }
  }

  // Sessione che attraversa la mezzanotte (Sydney 21→06)
  let isOpen
  if (closeUTC > openUTC) {
    isOpen = m >= openUTC && m < closeUTC
  } else {
    // wraps midnight
    isOpen = m >= openUTC || m < closeUTC
  }

  if (isOpen) {
    let closesIn
    if (closeUTC > openUTC) closesIn = closeUTC - m
    else closesIn = m >= openUTC ? (24*60 - m + closeUTC) : (closeUTC - m)
    return { open: true, opensIn: 0, closesIn }
  } else {
    let opensIn
    if (m < openUTC) opensIn = openUTC - m
    else opensIn = (24*60 - m) + openUTC
    return { open: false, opensIn, closesIn: null }
  }
}

function minutesToNextOpen(session, now) {
  const day = now.getUTCDay()
  const m   = nowMinutesUTC(now)
  let daysUntilMonday
  if (day === 6) daysUntilMonday = 2  // sabato
  else if (day === 0) daysUntilMonday = 1  // domenica
  else daysUntilMonday = 0
  return daysUntilMonday * 24 * 60 + (session.openUTC - m + 24 * 60) % (24 * 60)
}

// Format minutes → "Xh Ym"
export function fmtDuration(mins) {
  if (mins == null) return '—'
  if (mins <= 0) return 'ora'
  const h = Math.floor(mins / 60)
  const m = mins % 60
  if (h === 0) return `${m}m`
  if (m === 0) return `${h}h`
  return `${h}h ${m}m`
}

// Format UTC minutes → "HH:MM" in ora locale italiana
export function fmtLocalFromUTC(utcMinutes, now = new Date()) {
  const baseDay = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()))
  baseDay.setUTCMinutes(utcMinutes)
  return baseDay.toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' })
}
