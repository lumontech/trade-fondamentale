// Scoring Engine — combina segnale tecnico + fattori fondamentali
// Output: raccomandazione LONG / SHORT / FLAT con percentuale di confidenza

// Map strumento → valute coinvolte (per filtrare eventi del calendario)
const SYMBOL_CURRENCIES = {
  BTCUSD:  ['USD'],
  XAUUSD:  ['USD'],          // oro inverso al USD
  EURUSD:  ['EUR', 'USD'],
  GBPUSD:  ['GBP', 'USD'],
  USDJPY:  ['USD', 'JPY'],
  GBPJPY:  ['GBP', 'JPY'],
  US500:   ['USD'],
  NAS100:  ['USD'],
  USOIL:   ['USD'],
  DXY:     ['USD'],
}

// Quale valuta è "base" — un dato forte sulla base = segnale LONG
const BASE_CURRENCY = {
  EURUSD: 'EUR',
  GBPUSD: 'GBP',
  USDJPY: 'USD',
  GBPJPY: 'GBP',
  XAUUSD: null,    // logica inversa: USD forte → oro debole
  BTCUSD: null,
  US500:  null,
  NAS100: null,
  USOIL:  null,
  DXY:    'USD',
}

// Strumenti risk-on (correlati positivi al sentiment)
const RISK_ON = ['US500', 'NAS100', 'BTCUSD']
// Strumenti risk-off / safe haven
const RISK_OFF = ['XAUUSD']

const HOUR = 60 * 60 * 1000

/**
 * Calcola la raccomandazione operativa per uno strumento.
 * @param {Object} ctx
 *   - symbol, technicalSignal, events, marketContext, now
 *   - backtestStats: output di getBacktestStats() — { byLabel, summary }
 *   - crossAsset: output di crossAssetConfirmation() — { score, confirms, diverges, label }
 * @returns {Object} { direction, confidence, techScore, fundScore, histScore, blockers, reasons }
 */
// Map strumento → tag ricerca news
const SYMBOL_NEWS_TAGS = {
  EURUSD: ['EUR', 'USD'],
  GBPUSD: ['GBP', 'USD'],
  USDJPY: ['USD', 'JPY'],
  GBPJPY: ['GBP', 'JPY'],
  XAUUSD: ['XAU', 'USD'],
  USOIL:  ['OIL', 'USD'],
  US500:  ['SPX', 'USD'],
  NAS100: ['NDX', 'USD'],
  DXY:    ['USD'],
  BTCUSD: ['BTC', 'USD'],
}

export function calculateRecommendation({ symbol, technicalSignal, events = [], marketContext = {}, backtestStats = null, crossAsset = null, cot = null, news = [], mtf = null, smc = null, regime = null, patterns = [], now = new Date() }) {
  const reasons   = []
  const blockers  = []

  // ── 1) Score tecnico normalizzato −100..+100 ───────────────────
  // technicalSignal.score va da −6.5 a +6.5
  let techScore = 0
  if (technicalSignal) {
    techScore = Math.max(-100, Math.min(100, (technicalSignal.score / 6.5) * 100))
    reasons.push({
      type:  'technical',
      label: `Tecnico: ${technicalSignal.label}`,
      detail: `Score ${techScore.toFixed(0)} (RSI/MACD/EMA/BB)`,
      score: techScore,
    })
  }

  // ── 1.0) Volatility regime — modula la confidenza ─────────────
  // Trend → boost di setup direzionali. Range → penalty su EMA crossover.
  // Squeeze → attesa breakout, bassa confidence di entry direzionali.
  let regimePenalty = 0
  if (regime) {
    if (regime.regime === 'range' && technicalSignal && Math.abs(technicalSignal.score) > 2) {
      // In range, segnali EMA forti spesso falliscono
      regimePenalty = 20
      reasons.push({
        type:  'regime',
        label: `Regime: RANGE (ADX ${regime.adx})`,
        detail: `${regime.strategy_hint} — penalty su trend-following`,
        score: 0,
      })
    } else if (regime.regime === 'strong-trend' || regime.regime === 'trend') {
      reasons.push({
        type:  'regime',
        label: `Regime: ${regime.regime.toUpperCase()} (ADX ${regime.adx})`,
        detail: regime.strategy_hint,
        score: 0,
      })
    } else if (regime.regime === 'squeeze') {
      regimePenalty = 15
      reasons.push({
        type:  'regime',
        label: `Regime: SQUEEZE (BB width ${regime.bb_width_percentile}° pct)`,
        detail: 'Volatilità compressa: aspetta breakout prima di entrare',
        score: 0,
      })
    }
  }

  // ── 1.0b) Chart Patterns recognition (candlestick + chart + harmonic) ──
  if (patterns && patterns.length > 0) {
    let patternScore = 0
    const w = { high: 12, medium: 7, low: 3 }
    for (const p of patterns) {
      const weight = w[p.reliability] || 5
      // Boost extra per harmonic (più affidabili)
      const multiplier = p.type === 'harmonic' ? 1.6 : p.type === 'chart' ? 1.2 : 1
      const delta = weight * multiplier
      if (p.bias === 'bullish') patternScore += delta
      else if (p.bias === 'bearish') patternScore -= delta
    }
    patternScore = Math.max(-100, Math.min(100, patternScore))

    if (Math.abs(patternScore) > 5) {
      // Combina con tecnico (peso 25% del techScore)
      techScore = techScore * 0.75 + patternScore * 0.25
      const top = patterns.slice(0, 3).map(p => p.italian || p.name).join(', ')
      reasons.push({
        type:  'patterns',
        label: `Pattern: ${patterns.length} detectati (${top})`,
        detail: `Score pattern ${Math.round(patternScore)} • ${patterns.filter(p => p.type === 'harmonic').length} armonici`,
        score: Math.round(patternScore * 0.25),
      })
    }
  }

  // ── 1a) SMC — Smart Money Concepts (BOS, CHoCH, struttura) ────
  if (smc && smc.structure) {
    let smcScore = 0
    if (smc.bias === 'bullish_continuation') smcScore = +20
    else if (smc.bias === 'bearish_continuation') smcScore = -20
    else if (smc.bias === 'bullish_reversal') smcScore = +30   // CHoCH bullish: forte
    else if (smc.bias === 'bearish_reversal') smcScore = -30
    if (smcScore !== 0) {
      // Combina con tecnico (peso 30% del techScore)
      techScore = techScore * 0.7 + smcScore * 0.3
      reasons.push({
        type:  'smc',
        label: `SMC: ${smc.bias.replace('_', ' ')}`,
        detail: smc.structure.choch
          ? `Change of Character (${smc.structure.choch.type}) @ ${smc.structure.choch.level}`
          : smc.structure.bos
            ? `Break of Structure (${smc.structure.bos.type}) @ ${smc.structure.bos.level}`
            : `Trend: ${smc.structure.trend}`,
        score: smcScore * 0.3,
      })
    }
  }

  // ── 1b) MTF confluence — porta il tecnico al livello pro ──────
  // Combina techScore single-TF con confluenceScore MTF (60/40)
  if (mtf && mtf.totalCount >= 2) {
    const mtfScore = mtf.confluenceScore   // -100..+100
    // Se le TF concordano fortemente con il segnale, boost. Se discordano, penalty.
    const alignedRatio = mtf.alignedCount / mtf.totalCount
    techScore = techScore * 0.6 + mtfScore * 0.4
    techScore = Math.max(-100, Math.min(100, techScore))
    reasons.push({
      type:  'mtf',
      label: `MTF Confluence: ${mtf.alignedCount}/${mtf.totalCount} TF concordano (${mtf.dominantBias})`,
      detail: `Score MTF ${mtfScore} • ${Object.entries(mtf.timeframes).map(([tf, t]) => `${tf}:${t.label}`).join(' · ')}`,
      score: mtfScore * 0.4,    // peso effettivo nel techScore finale
    })
    // Bonus confidence se consenso totale
    if (alignedRatio === 1 && mtf.totalCount >= 3) {
      reasons.push({
        type:  'mtf-consensus',
        label: '⚡ Consenso totale MTF',
        detail: 'Tutti i timeframe analizzati concordano sulla direzione',
        score: 0,
      })
    }
  }

  // ── 2) Eventi imminenti sulle valute dello strumento ──────────
  const currencies = SYMBOL_CURRENCIES[symbol] || []
  const upcoming = events
    .filter(e => e.date > now && currencies.includes(e.currency))
    .sort((a, b) => a.date - b.date)

  // BLOCKER: evento ALTO impatto entro 1 ora → forza FLAT
  const imminent = upcoming.find(e => e.impact === 'High' && (e.date - now) < HOUR)
  if (imminent) {
    const minutes = Math.round((imminent.date - now) / 60000)
    blockers.push({
      type:  'event',
      label: `Evento ad ALTO impatto tra ${minutes} min`,
      detail: `${imminent.currency} • ${imminent.title}`,
    })
  }

  // SOFT: evento ALTO entro 4h → riduce confidence
  const nearHigh = upcoming.find(e =>
    e.impact === 'High' && (e.date - now) >= HOUR && (e.date - now) < 4 * HOUR
  )
  // SOFT: evento MEDIO entro 2h
  const nearMed = upcoming.find(e =>
    e.impact === 'Medium' && (e.date - now) < 2 * HOUR
  )

  let confidencePenalty = 0
  if (nearHigh) {
    confidencePenalty += 20
    const hours = Math.round((nearHigh.date - now) / HOUR)
    reasons.push({
      type:  'event-soft',
      label: `Evento ALTO impatto fra ${hours}h`,
      detail: `${nearHigh.currency} • ${nearHigh.title} → confidence ridotta`,
      score: 0,
    })
  }
  if (nearMed) {
    confidencePenalty += 10
    reasons.push({
      type:  'event-soft',
      label: 'Evento MEDIO impatto in arrivo',
      detail: `${nearMed.currency} • ${nearMed.title}`,
      score: 0,
    })
  }

  // ── 3) Score fondamentale ──────────────────────────────────────
  let fundScore = 0
  let fundCount = 0

  // 3a) Risk sentiment via Fear & Greed
  const fg = marketContext.fearGreed
  if (fg && RISK_ON.includes(symbol)) {
    // Risk-on asset: greed → bullish, fear → bearish
    const fgScore = ((fg.value - 50) / 50) * 60   // ±60 max
    fundScore += fgScore
    fundCount++
    reasons.push({
      type:  'sentiment',
      label: `Fear & Greed: ${fg.label} (${fg.value})`,
      detail: fgScore > 0 ? 'Sentiment favorevole risk-on' : 'Sentiment risk-off, prudenza',
      score: fgScore,
    })
  }
  if (fg && RISK_OFF.includes(symbol)) {
    // Safe haven: fear → bullish, greed → bearish
    const fgScore = ((50 - fg.value) / 50) * 50
    fundScore += fgScore
    fundCount++
    reasons.push({
      type:  'sentiment',
      label: `Fear & Greed: ${fg.label} (${fg.value})`,
      detail: fgScore > 0 ? 'Fear: oro favorito come safe-haven' : 'Greed: oro penalizzato',
      score: fgScore,
    })
  }

  // 3b) BTC dominance — segnale per crypto
  if (symbol === 'BTCUSD' && marketContext.change24h != null) {
    const macroScore = Math.max(-40, Math.min(40, marketContext.change24h * 4))
    fundScore += macroScore
    fundCount++
    reasons.push({
      type:  'macro',
      label: `Crypto market 24h: ${marketContext.change24h.toFixed(2)}%`,
      detail: macroScore > 0 ? 'Mercato crypto in espansione' : 'Mercato crypto in contrazione',
      score: macroScore,
    })
  }

  // 3d) VIX — risk on/off via volatilità implicita
  const vix = marketContext.vix
  if (vix && vix.value != null) {
    let vixScore = 0
    if (RISK_ON.includes(symbol)) {
      // VIX alto → risk-off → asset risk-on debole
      vixScore = vix.value > 25 ? -25 : vix.value > 18 ? -10 : vix.value < 14 ? +15 : 0
    } else if (RISK_OFF.includes(symbol)) {
      // VIX alto → fly-to-safety → oro forte
      vixScore = vix.value > 25 ? +25 : vix.value > 18 ? +10 : vix.value < 14 ? -10 : 0
    }
    if (vixScore !== 0) {
      fundScore += vixScore
      fundCount++
      reasons.push({
        type:  'vix',
        label: `VIX: ${vix.value.toFixed(2)}`,
        detail: vix.value > 25 ? 'Volatilità elevata, regime risk-off'
              : vix.value > 18 ? 'Volatilità sopra media'
              : vix.value < 14 ? 'Volatilità bassa, complacency'
              : 'Volatilità normale',
        score: vixScore,
      })
    }
  }

  // 3e) Yield curve 10Y-2Y — recession indicator + USD strength
  const spread = marketContext.spread10y2y
  if (spread && spread.value != null) {
    // Spread negativo = curva invertita = segnale recessione
    const inverted = spread.value < 0
    if (BASE_CURRENCY[symbol] === 'USD') {
      // USD base: yields alti → USD forte (long); curva ripida → buona salute economica
      const yieldScore = inverted ? -10 : Math.min(10, spread.value * 10)
      if (Math.abs(yieldScore) > 1) {
        fundScore += yieldScore
        fundCount++
        reasons.push({
          type:  'yields',
          label: `Spread 10Y-2Y: ${spread.value.toFixed(2)}%`,
          detail: inverted ? 'Curva invertita — segnale recessione storico' : 'Curva normale, USD supportato',
          score: yieldScore,
        })
      }
    } else if (currencies.includes('USD') && symbol !== 'USDJPY') {
      // USD quote: invertito (USD forte → quote contraria al USD scende)
      const yieldScore = inverted ? +10 : -Math.min(10, spread.value * 10)
      if (Math.abs(yieldScore) > 1) {
        fundScore += yieldScore
        fundCount++
        reasons.push({
          type:  'yields',
          label: `Spread 10Y-2Y: ${spread.value.toFixed(2)}%`,
          detail: inverted ? 'Curva USA invertita, EUR/GBP relativamente meno deboli' : 'Yields USA in salute, USD forte',
          score: yieldScore,
        })
      }
    }
  }

  // 3f) US10Y daily change — momentum del dollaro
  const us10y = marketContext.us10y
  if (us10y && us10y.changePct != null && Math.abs(us10y.changePct) > 0.5) {
    // Yields salgono → USD forte
    let yScore = Math.max(-15, Math.min(15, us10y.changePct * 5))
    if (BASE_CURRENCY[symbol] !== 'USD' && currencies.includes('USD')) {
      yScore = -yScore   // strumento con USD quote: yields su → strumento giù
    } else if (RISK_OFF.includes(symbol)) {
      yScore = -yScore   // oro: yields su → oro giù (no yield asset)
    }
    if (Math.abs(yScore) > 2) {
      fundScore += yScore
      fundCount++
      reasons.push({
        type:  'us10y',
        label: `US10Y: ${us10y.value.toFixed(2)}% (${us10y.changePct > 0 ? '+' : ''}${us10y.changePct.toFixed(1)}%)`,
        detail: us10y.changePct > 0 ? 'Yields in salita: USD favorito' : 'Yields in calo: USD sotto pressione',
        score: yScore,
      })
    }
  }

  // 3c) Dato fondamentale recente: forecast vs previous nelle ultime 6h
  const recentBaseEvents = events.filter(e =>
    e.date <= now &&
    (now - e.date) < 6 * HOUR &&
    currencies.includes(e.currency) &&
    e.impact === 'High' &&
    e.forecast && e.previous
  )
  for (const ev of recentBaseEvents) {
    const fc = parseFloat(ev.forecast)
    const pv = parseFloat(ev.previous)
    if (isNaN(fc) || isNaN(pv) || pv === 0) continue
    const surprise = ((fc - pv) / Math.abs(pv)) * 100  // % di sorpresa
    const base = BASE_CURRENCY[symbol]
    const isBase = ev.currency === base
    let surpriseScore = Math.max(-30, Math.min(30, surprise * 2))
    if (!isBase) surpriseScore = -surpriseScore   // valuta quote → effetto inverso
    fundScore += surpriseScore
    fundCount++
    reasons.push({
      type:  'macro-recent',
      label: `${ev.currency} ${ev.title}`,
      detail: `Forecast ${ev.forecast} vs Prev ${ev.previous}`,
      score: surpriseScore,
    })
  }

  // 3f.bis) Session context — overlap forex genera volatilità (non direzionale, boost confidence)
  const m = now.getUTCHours() * 60 + now.getUTCMinutes()
  const day = now.getUTCDay()
  const isWeekday = day >= 1 && day <= 5
  // Overlap London-NY: 12-16 UTC (14-18 IT)
  const inOverlap = isWeekday && m >= 12*60 && m < 16*60
  // Sessione "morta" tra NY close e Sydney open: 21:00-22:00 UTC + weekend
  const isDeadHours = !isWeekday || (m >= 21*60 || m < 0)
  if (inOverlap && Math.abs(techScore) > 20) {
    reasons.push({
      type:  'session',
      label: 'Overlap London-NY attivo',
      detail: 'Massima liquidità e volatilità — entry più affidabili',
      score: 0,    // non sposta direzione, ma è citato come contesto positivo
    })
  }
  if (isDeadHours) {
    reasons.push({
      type:  'session',
      label: 'Sessione morta',
      detail: 'Liquidità bassa, attendere apertura Sydney/Tokyo',
      score: 0,
    })
  }

  // 3g) COT — posizionamento large speculators (non-commercials)
  if (cot && cot.netNc != null) {
    // % long degli speculatori: > 65% extreme → contrarian short risk
    // < 35% extreme → contrarian long opportunity
    let cotScore = 0
    const pct = cot.ncPctLong
    if (pct > 0.70)      cotScore = -20      // Estremo crowded long → mean reversion bearish
    else if (pct > 0.60) cotScore = +10      // Smart money long, follow
    else if (pct < 0.30) cotScore = +20      // Estremo short → contrarian long
    else if (pct < 0.40) cotScore = -10      // Smart money short, follow
    // Cambio settimanale: positivo = sentiment in miglioramento
    if (cot.changePct != null) {
      const trendBonus = Math.max(-10, Math.min(10, cot.changePct / 5))
      cotScore += trendBonus
    }
    fundScore += cotScore
    fundCount++
    reasons.push({
      type:  'cot',
      label: `COT: ${cot.sentiment} (${(pct * 100).toFixed(0)}% long)`,
      detail: `Net spec ${cot.netNc.toLocaleString()} contratti${cot.changePct != null ? ` • ${cot.changePct > 0 ? '+' : ''}${cot.changePct.toFixed(1)}% vs settimana scorsa` : ''}`,
      score: cotScore,
    })
  }

  // 3h) News sentiment — ultime 12h, asset-specific
  const symbolTags = SYMBOL_NEWS_TAGS[symbol] || []
  if (symbolTags.length && news.length) {
    const cutoff = now.getTime() - 12 * HOUR
    const relevant = news.filter(n =>
      n.date.getTime() > cutoff &&
      n.tags?.some(t => symbolTags.includes(t))
    ).slice(0, 15)

    if (relevant.length >= 3) {
      const avgSentiment = relevant
        .filter(n => n.sentiment != null && n.sentiment !== 0)
        .reduce((s, n) => s + n.sentiment, 0) / Math.max(1, relevant.length)
      const newsScore = avgSentiment * 25   // ±25 max
      if (Math.abs(newsScore) > 3) {
        fundScore += newsScore
        fundCount++
        reasons.push({
          type:  'news',
          label: `News ${symbolTags.join('/')}: ${relevant.length} headline 12h`,
          detail: `Sentiment medio ${avgSentiment > 0 ? '+' : ''}${avgSentiment.toFixed(2)}`,
          score: newsScore,
        })
      }
    }
  }

  // Normalizza fundScore se ho più componenti
  if (fundCount > 1) fundScore = fundScore / fundCount * 1.2
  fundScore = Math.max(-100, Math.min(100, fundScore))

  // ── 4) Score storico (backtest reale sui dati) ────────────────
  let histScore = 0
  let histInfo  = null
  if (backtestStats && technicalSignal) {
    const stats = backtestStats.byLabel?.[technicalSignal.label]
    if (stats && stats.total >= 5) {
      // win rate 50% = neutro. >50% positivo, <50% negativo.
      // Range: ±60 max. Pesato per dimensione campione (saturation a 30 trade).
      const sampleWeight = Math.min(1, stats.total / 30)
      const wrScore = (stats.winRate - 0.5) * 200 * sampleWeight   // -100..+100
      // Profit factor bonus: PF > 1.5 → bonus, < 1 → malus
      let pfScore = 0
      if (isFinite(stats.profitFactor)) {
        pfScore = (stats.profitFactor - 1) * 30
        pfScore = Math.max(-30, Math.min(30, pfScore))
      } else if (stats.profitFactor === Infinity) {
        pfScore = 30
      }
      histScore = (wrScore * 0.7 + pfScore * 0.3)
      histScore = Math.max(-100, Math.min(100, histScore))
      // Direzione: il segnale è bullish o bearish? Allinea il segno
      if (technicalSignal.label.includes('VENDI')) histScore = -histScore

      histInfo = {
        sample:       stats.total,
        winRate:      stats.winRate,
        profitFactor: stats.profitFactor,
        avgRR:        stats.avgRR,
      }
      reasons.push({
        type:  'historical',
        label: `Storico ${technicalSignal.label}: ${(stats.winRate * 100).toFixed(0)}% win su ${stats.total} trade`,
        detail: `PF ${isFinite(stats.profitFactor) ? stats.profitFactor.toFixed(2) : '∞'} • R:R medio ${stats.avgRR.toFixed(2)}`,
        score: histScore,
      })
    } else if (stats) {
      reasons.push({
        type:  'historical-low',
        label: `Storico insufficiente (${stats.total} trade)`,
        detail: 'Servono almeno 5 trade per usare il backtest',
        score: 0,
      })
    }
  }

  // ── 4b) Cross-asset confirmation ──────────────────────────────
  let crossScore = 0
  if (crossAsset && crossAsset.total > 0) {
    crossScore = crossAsset.score
    reasons.push({
      type:  'cross-asset',
      label: crossAsset.label,
      detail: `${crossAsset.confirms}/${crossAsset.total} asset correlati confermano`,
      score: crossScore,
    })
  }

  // ── 5) Combinazione finale (T 45% + F 30% + S 15% + X 10%) ────
  const combined = blockers.length > 0
    ? 0
    : techScore * 0.45 + fundScore * 0.30 + histScore * 0.15 + crossScore * 0.10

  // ── 5) Direction & confidence ─────────────────────────────────
  let direction = 'FLAT'
  if (blockers.length === 0) {
    if (combined >= 25) direction = 'LONG'
    else if (combined <= -25) direction = 'SHORT'
  }

  // Confidence: forza assoluta del segnale - eventuali penalità
  let confidence = Math.min(100, Math.abs(combined))
  confidence = Math.max(0, confidence - confidencePenalty - regimePenalty)
  if (blockers.length > 0) confidence = 0
  if (direction === 'FLAT' && blockers.length === 0) {
    // Se siamo flat per debolezza segnale, mostra comunque la "convinzione del flat"
    confidence = Math.min(100, 50 - Math.abs(combined))
  }

  return {
    direction,
    confidence: Math.round(confidence),
    combined:   Math.round(combined),
    techScore:  Math.round(techScore),
    fundScore:  Math.round(fundScore),
    histScore:  Math.round(histScore),
    crossScore: Math.round(crossScore),
    histInfo,
    crossAsset,
    blockers,
    reasons,
    nextEvent:  upcoming[0] || null,
  }
}
