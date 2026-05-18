// Seasonality — analisi pattern temporali sulle candele storiche.
// Risponde a: "quale giorno della settimana è migliore per LONG su EURUSD?"
// "Quale ora del giorno UTC è più volatile su XAUUSD?"

const DOW_LABELS = ['Dom', 'Lun', 'Mar', 'Mer', 'Gio', 'Ven', 'Sab']

/**
 * Aggrega le candele per giorno della settimana e per ora del giorno (UTC).
 * Per ogni gruppo: average return, % giorni positivi, range medio.
 */
export function analyzeSeasonality(candles) {
  if (!candles || candles.length < 100) return null

  // Per giorno settimana (DOW): aggrega le candele in giorni completi
  // Per ogni candela calcola return = (close - open) / open
  // Per ora del giorno: solo se TF intraday

  const byDow = {}     // 0..6 => { count, returns[], positive }
  const byHour = {}    // 0..23 => { count, returns[], range[] }

  for (const c of candles) {
    if (!c.time || !c.open || !c.close) continue
    const d = new Date(c.time * 1000)
    const dow = d.getUTCDay()
    const hour = d.getUTCHours()
    const ret = (c.close - c.open) / c.open
    const range = (c.high - c.low) / c.open

    if (!byDow[dow]) byDow[dow] = { count: 0, returns: [], positive: 0 }
    byDow[dow].count++
    byDow[dow].returns.push(ret)
    if (ret > 0) byDow[dow].positive++

    if (!byHour[hour]) byHour[hour] = { count: 0, returns: [], range: [] }
    byHour[hour].count++
    byHour[hour].returns.push(ret)
    byHour[hour].range.push(range)
  }

  const summarizeDow = Object.entries(byDow).map(([dow, data]) => ({
    day:        DOW_LABELS[parseInt(dow)],
    dow:        parseInt(dow),
    count:      data.count,
    avg_return: data.returns.reduce((s, x) => s + x, 0) / data.count,
    positive_rate: data.positive / data.count,
  })).sort((a, b) => a.dow - b.dow)

  const summarizeHour = Object.entries(byHour).map(([hr, data]) => ({
    hour_utc:   parseInt(hr),
    hour_local: (parseInt(hr) + 2) % 24,    // CEST UTC+2 (approx, ignora DST switch)
    count:      data.count,
    avg_return: data.returns.reduce((s, x) => s + x, 0) / data.count,
    avg_range:  data.range.reduce((s, x) => s + x, 0) / data.count,
  })).sort((a, b) => a.hour_utc - b.hour_utc)

  // Best/worst day
  const bestDay  = [...summarizeDow].filter(d => d.count >= 5)
                                    .sort((a, b) => b.avg_return - a.avg_return)[0]
  const worstDay = [...summarizeDow].filter(d => d.count >= 5)
                                    .sort((a, b) => a.avg_return - b.avg_return)[0]
  const mostVolatileHour = [...summarizeHour].filter(h => h.count >= 5)
                                              .sort((a, b) => b.avg_range - a.avg_range)[0]

  return {
    by_dow:  summarizeDow,
    by_hour: summarizeHour,
    insights: {
      best_day:  bestDay  ? { day: bestDay.day,  positive_rate: Math.round(bestDay.positive_rate * 100),
                              avg_return_bp: Math.round(bestDay.avg_return * 10000) }
                          : null,
      worst_day: worstDay ? { day: worstDay.day, positive_rate: Math.round(worstDay.positive_rate * 100),
                              avg_return_bp: Math.round(worstDay.avg_return * 10000) }
                          : null,
      most_volatile_hour_local: mostVolatileHour
        ? { hour: mostVolatileHour.hour_local + ':00', avg_range_bp: Math.round(mostVolatileHour.avg_range * 10000) }
        : null,
    },
  }
}

// Sintesi per ContextPack (token-efficient)
export function summarizeSeasonality(season) {
  if (!season) return null
  return {
    insights: season.insights,
    by_dow:   season.by_dow.map(d => ({
      day: d.day,
      win_rate_pct: Math.round(d.positive_rate * 100),
      avg_return_bp: Math.round(d.avg_return * 10000),
    })),
  }
}
