// ContextPack — costruisce uno snapshot strutturato e token-efficient
// di tutto il contesto di trading, da inviare a Claude API.
import { calculateSignal, calcPivots, findLevels } from '../utils/indicators'
import { getBacktestStats } from './BacktestEngine'
import { calculateCorrelationMatrix, getTopCorrelations } from './CorrelationEngine'
import { extractTags, quickSentiment } from './NewsService'
import { getSessionStatus, SESSIONS, FX_OVERLAPS } from './MarketSessions'
import { calculateMTFConfluence, summarizeMTF } from './MTFConfluence'
import { analyzeSMC, summarizeSMC } from './SMCEngine'
import { detectVolatilityRegime } from './VolatilityRegime'
import { analyzeSeasonality, summarizeSeasonality } from './Seasonality'
import { getApplicableRules } from './MacroRules'
import { detectAllPatterns, summarizePatterns } from './PatternsEngine'
import { calculateCurrencyStrength } from './CurrencyStrength'
import { calculateVolumeProfile, summarizeVolumeProfile } from './VolumeProfile'
import { calculateLiquidityHeatmap, summarizeLiquidity } from './LiquidityHeatmap'
import { calculateAllExtended } from './IndicatorsExtended'
import { buildHistoricalContext } from './HistoricalContext'
import { detectTrendlines, summarizeTrendlines } from './TrendlinesEngine'
import { runAllSetupBacktests, summarizeSetupBacktests } from './DynamicBacktest'

// Numero arrotondato per token-efficiency
function r(n, decimals = 2) {
  if (n == null || isNaN(n)) return null
  return Number(n.toFixed(decimals))
}

/**
 * Costruisce il Context Pack completo per uno strumento.
 * Output JSON pronto da serializzare e inviare a Claude.
 */
export function buildContextPack({ symbol, timeframe, instruments, events, marketContext, cot, news, now = new Date() }) {
  const inst = instruments[symbol]
  if (!inst || !inst.candles?.length) return null

  const candles = inst.candles
  const last    = candles[candles.length - 1]
  const price   = inst.price ?? last.close

  // ── Tecnico ───────────────────────────────────────────────────
  const signal = calculateSignal(candles)
  const pivots = calcPivots(candles)
  const levels = findLevels(candles, 50)

  const technical = {
    price:        r(price, 5),
    signal:       signal?.label,
    score:        signal?.score,
    trend:        signal?.bars >= 4 ? 'strong-up' : signal?.bars >= 3 ? 'up' : signal?.bars === 2 ? 'down' : 'strong-down',
    ema: {
      ema20:  r(signal?.ema?.v20, 5),
      ema50:  r(signal?.ema?.v50, 5),
      ema200: r(signal?.ema?.v200, 5),
      ema20_above_50:   signal?.ema?.v20 > signal?.ema?.v50,
      price_above_200:  price > signal?.ema?.v200,
    },
    rsi: signal?.rsi ? { value: r(signal.rsi.value, 1), state: signal.rsi.signal } : null,
    macd: signal?.macd ? { trend: signal.macd.trend, momentum: signal.macd.momentum } : null,
    bb: signal?.bb ? { position: signal.bb.signal, bandwidth_pct: r(signal.bb.bandwidth, 2) } : null,
    levels: {
      pivot:        pivots ? { P: r(pivots.P, 5), R1: r(pivots.R1, 5), R2: r(pivots.R2, 5), S1: r(pivots.S1, 5), S2: r(pivots.S2, 5) } : null,
      resistances:  levels.resistances.slice(-3).map(v => r(v, 5)),
      supports:     levels.supports.slice(0, 3).map(v => r(v, 5)),
    },
  }

  // ── Backtest reale (legacy: per signal label aggregato) ────────
  const backtest = getBacktestStats(symbol, timeframe, candles)
  const histStats = backtest?.byLabel?.[signal?.label]
  const backtestHistory = histStats ? {
    label:        signal.label,
    sample:       histStats.total,
    win_rate:     r(histStats.winRate, 3),
    profit_factor: isFinite(histStats.profitFactor) ? r(histStats.profitFactor, 2) : 'inf',
    avg_rr:       r(histStats.avgRR, 2),
    expectancy:   r(histStats.expectancy, 4),
    max_dd_R:     r(histStats.maxDD, 1),
  } : null

  // ── Backtest dinamico setup-specifico ─────────────────────────
  // Calcola WR/avg_R/profit_factor di ~12 setup pre-definiti sulle
  // ultime candele DELL'ASSET CORRENTE. Claude lo riceve come filtro
  // per modulare confidence in base alla performance recente del pattern.
  // ~100-300ms per asset, 0% costo API extra.
  let setupBacktestsSummary = null
  try {
    if (Array.isArray(candles) && candles.length >= 250) {
      const allBT = runAllSetupBacktests(candles)
      setupBacktestsSummary = summarizeSetupBacktests(allBT)
    }
  } catch (err) {
    console.warn('[ContextPack] dynamic backtest skipped:', err.message)
  }

  // ── Eventi ravvicinati ────────────────────────────────────────
  const HOUR = 3600 * 1000
  const upcomingEvents = events
    .filter(e => e.date > now && e.date - now < 24 * HOUR && e.impact !== 'Low')
    .slice(0, 8)
    .map(e => ({
      title:    e.title,
      currency: e.currency,
      impact:   e.impact,
      hours:    r((e.date - now) / HOUR, 1),
      forecast: e.forecast || null,
      previous: e.previous || null,
    }))

  // Regole macro applicabili agli eventi imminenti
  const macroRules = getApplicableRules(events, symbol, now)

  // ── Context macro ─────────────────────────────────────────────
  const macro = {
    fear_greed:     marketContext.fearGreed ? { value: marketContext.fearGreed.value, label: marketContext.fearGreed.label } : null,
    btc_dominance:  r(marketContext.btcDominance, 2),
    us10y:          marketContext.us10y?.value != null ? { value: r(marketContext.us10y.value, 2), change_pct: r(marketContext.us10y.changePct, 2) } : null,
    us2y:           marketContext.us2y?.value != null ? { value: r(marketContext.us2y.value, 2) } : null,
    spread_10y2y:   marketContext.spread10y2y?.value != null ? r(marketContext.spread10y2y.value, 2) : null,
    vix:            marketContext.vix?.value != null ? r(marketContext.vix.value, 2) : null,
    dxy:            marketContext.dxy?.value != null ? r(marketContext.dxy.value, 2) : null,
  }

  // ── Sessione corrente ─────────────────────────────────────────
  const sessionStates = SESSIONS.map(s => ({
    id:     s.id,
    label:  s.label,
    open:   getSessionStatus(s, now).open,
  }))
  const m = now.getUTCHours() * 60 + now.getUTCMinutes()
  const day = now.getUTCDay()
  const inOverlap = day >= 1 && day <= 5 && m >= 12*60 && m < 16*60
  const session = {
    open_now: sessionStates.filter(s => s.open).map(s => s.id),
    london_ny_overlap: inOverlap,
  }

  // ── COT ───────────────────────────────────────────────────────
  const cotData = cot ? {
    sentiment:    cot.sentiment,
    pct_long:     r(cot.ncPctLong, 3),
    net_contracts: cot.netNc,
    change_pct:   r(cot.changePct, 1),
    report_date:  cot.date,
  } : null

  // ── News asset-specific ultime 12h ────────────────────────────
  const SYM_TAGS = {
    EURUSD: ['EUR', 'USD'], GBPUSD: ['GBP', 'USD'], USDJPY: ['USD', 'JPY'],
    GBPJPY: ['GBP', 'JPY'], XAUUSD: ['XAU', 'USD'], USOIL: ['OIL', 'USD'],
    US500: ['SPX', 'USD'], NAS100: ['NDX', 'USD'], DXY: ['USD'], BTCUSD: ['BTC', 'USD'],
  }
  const tags = SYM_TAGS[symbol] || []
  const recentNews = (news || [])
    .filter(n => {
      const newsDate = n.date instanceof Date ? n.date : new Date(n.date)
      const newsTags = n.tags || extractTags(n.headline + ' ' + (n.summary || ''))
      return newsDate > new Date(now.getTime() - 12 * HOUR) &&
             newsTags.some(t => tags.includes(t))
    })
    .slice(0, 8)
    .map(n => ({
      time_ago_h: r((now.getTime() - (n.date instanceof Date ? n.date : new Date(n.date)).getTime()) / HOUR, 1),
      headline:   n.headline,
      sentiment:  r(n.sentiment != null ? n.sentiment : quickSentiment(n.headline), 2),
      source:     n.source,
    }))

  // ── Cross-asset top correlations ──────────────────────────────
  const { matrix } = calculateCorrelationMatrix(instruments, 100)
  const corrs = getTopCorrelations(symbol, matrix, 3)
  // Per ogni correlato top, dammi il trend recent
  const correlatedAssets = [...corrs.positive, ...corrs.negative].map(c => {
    const cInst = instruments[c.symbol]
    if (!cInst?.candles?.length) return null
    const last20 = cInst.candles.slice(-20)
    const trend_pct = last20[0].close ? r(((last20[last20.length-1].close - last20[0].close) / last20[0].close) * 100, 2) : null
    return { symbol: c.symbol, correlation: r(c.corr, 2), trend_20bars_pct: trend_pct }
  }).filter(Boolean)

  // ── MTF confluence ────────────────────────────────────────────
  const mtfConf = calculateMTFConfluence(inst)
  const mtfSummary = summarizeMTF(mtfConf)

  // ── SMC analysis ──────────────────────────────────────────────
  const smc = analyzeSMC(candles)
  const smcSummary = summarizeSMC(smc)

  // ── Volatility regime + Stagionalità ──────────────────────────
  const regime = detectVolatilityRegime(candles)
  const seasonality = summarizeSeasonality(analyzeSeasonality(candles))

  // ── Pattern recognition ───────────────────────────────────────
  const allPatterns = detectAllPatterns(candles)
  const patternsSummary = summarizePatterns(allPatterns)

  // ── Volume Profile + Liquidity Heatmap ────────────────────────
  const vp = summarizeVolumeProfile(calculateVolumeProfile(candles, 100, 30))
  const liq = summarizeLiquidity(calculateLiquidityHeatmap(candles, 100))

  // ── Indicatori estesi (Fibonacci, Ichimoku, Stochastic, ecc.) ─
  const extendedIndicators = calculateAllExtended(candles)

  // ── Trendlines automatiche ────────────────────────────────────
  const trendlines = summarizeTrendlines(detectTrendlines(candles, 100, 3))

  // ── Storico (range, percentile, volatilità annualizzata) ──────
  const historical = buildHistoricalContext(candles)

  // ── Currency Strength ─────────────────────────────────────────
  const strength = calculateCurrencyStrength(instruments, 24)
  const strengthSummary = strength.sorted.length > 0 ? {
    strongest: strength.strongest,
    weakest:   strength.weakest,
    ranked:    strength.sorted.map(c => ({ currency: c.currency, strength: c.strength })),
  } : null

  // ── Backtest stats con Sharpe/Sortino/MonteCarlo ──────────────
  const summaryStats = backtest?.summary
  const quantitative = summaryStats ? {
    overall_win_rate: r(summaryStats.winRate, 3),
    profit_factor:    isFinite(summaryStats.profitFactor) ? r(summaryStats.profitFactor, 2) : 'inf',
    sharpe:           summaryStats.sharpe,
    sortino:          summaryStats.sortino === Infinity ? 'inf' : summaryStats.sortino,
    max_dd_R:         summaryStats.maxDD,
    monte_carlo_worst_dd_95: summaryStats.mc_worst_dd_95,
    monte_carlo_worst_final_5: summaryStats.mc_worst_final_5,
  } : null

  return {
    meta: {
      symbol,
      timeframe,
      timestamp_utc: now.toISOString(),
      timestamp_local: now.toLocaleString('it-IT', { timeZone: 'Europe/Rome' }),
    },
    technical,
    indicators_extended: extendedIndicators,
    trendlines,
    historical_context: historical,
    multi_timeframe: mtfSummary,
    smart_money_concepts: smcSummary,
    chart_patterns: patternsSummary,
    volume_profile: vp,
    liquidity_zones: liq,
    currency_strength: strengthSummary,
    volatility_regime: regime,
    seasonality,
    historical_backtest: backtestHistory,
    setup_specific_backtests: setupBacktestsSummary,
    quantitative_metrics: quantitative,
    fundamentals: {
      upcoming_events_24h: upcomingEvents,
      macro_rules:         macroRules,
      macro,
      cot: cotData,
      news_recent_12h:    recentNews,
    },
    market_state: {
      session,
      cross_asset_correlations: correlatedAssets,
    },
  }
}

// Versione compatta per debug e visualizzazione
export function summarizeContextPack(ctx) {
  if (!ctx) return 'no context'
  return {
    instrument: `${ctx.meta.symbol} ${ctx.meta.timeframe} @ ${ctx.technical.price}`,
    signal:     ctx.technical.signal,
    upcoming:   ctx.fundamentals.upcoming_events_24h.length,
    news:       ctx.fundamentals.news_recent_12h.length,
    overlap:    ctx.market_state.session.london_ny_overlap ? 'YES' : 'no',
    backtest:   ctx.historical_backtest
      ? `${(ctx.historical_backtest.win_rate * 100).toFixed(0)}% win on ${ctx.historical_backtest.sample}`
      : 'insufficient',
  }
}
