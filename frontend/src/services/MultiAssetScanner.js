// MultiAssetScanner — scansiona tutti gli strumenti caricati e produce ranking
// delle opportunità migliori. Veloce: usa ScoringEngine rule-based, non Claude API.
//
// Caso d'uso: l'utente è su BTCUSD, sistema dice FLAT (aspetta evento).
// Lo scanner trova che EUR/USD ha setup A+ e suggerisce di passare lì.
import { calculateSignal } from '../utils/indicators'
import { calculateRecommendation } from './ScoringEngine'
import { getBacktestStats } from './BacktestEngine'
import { calculateMTFConfluence } from './MTFConfluence'
import { analyzeSMC } from './SMCEngine'
import { detectVolatilityRegime } from './VolatilityRegime'
import { detectAllPatterns } from './PatternsEngine'
import { calculateCorrelationMatrix, crossAssetConfirmation } from './CorrelationEngine'
import { extractTags, quickSentiment } from './NewsService'

/**
 * Scansiona tutti gli strumenti con candele caricate.
 * Per ognuno calcola raccomandazione + score di "opportunity quality".
 *
 * @returns {Array} ranking opportunità ordinato dal migliore al peggiore
 */
export function scanAllAssets({ instruments, events, marketContext, cot, news, timeframe = '1h' }) {
  const enrichedNews = (news || []).map(n => ({
    ...n,
    tags: n.tags || extractTags(n.headline + ' ' + (n.summary || '')),
    sentiment: n.sentiment != null ? n.sentiment : quickSentiment(n.headline + ' ' + (n.summary || '')),
  }))
  const { matrix } = calculateCorrelationMatrix(instruments, 100)
  const now = new Date()
  const results = []

  for (const [symbol, inst] of Object.entries(instruments)) {
    if (!inst?.candles || inst.candles.length < 50) continue

    const technicalSignal = calculateSignal(inst.candles)
    if (!technicalSignal) continue

    const backtestStats = getBacktestStats(symbol, timeframe, inst.candles)
    const mtf = calculateMTFConfluence(inst)
    const smc = analyzeSMC(inst.candles)
    const regime = detectVolatilityRegime(inst.candles)
    const patterns = detectAllPatterns(inst.candles)
    const probableDir = technicalSignal.label.includes('COMPRA') ? 'LONG'
                      : technicalSignal.label.includes('VENDI') ? 'SHORT' : null
    let crossAsset = null
    if (probableDir) {
      crossAsset = crossAssetConfirmation(symbol, probableDir, instruments, matrix)
    }

    const rec = calculateRecommendation({
      symbol,
      technicalSignal,
      events,
      marketContext,
      backtestStats,
      crossAsset,
      cot: cot[symbol] || null,
      news: enrichedNews,
      mtf,
      smc,
      regime,
      patterns,
      now,
    })

    // "Opportunity quality": combinazione di confidence + assenza blocker + WR backtest
    let oppScore = 0
    if (rec.direction !== 'FLAT' && rec.blockers.length === 0) {
      oppScore = rec.confidence
      // Bonus se backtest WR alto
      const stats = backtestStats?.byLabel?.[technicalSignal.label]
      if (stats && stats.winRate >= 0.6) oppScore += 10
      // Bonus se MTF totale aligned
      if (mtf && mtf.alignedCount === mtf.totalCount && mtf.totalCount >= 3) oppScore += 15
      // Bonus se pattern armonico recente
      if (patterns.some(p => p.type === 'harmonic' && p.bias === probableDir.toLowerCase())) oppScore += 10
      // Bonus se overlap london-ny
      const m = now.getUTCHours() * 60 + now.getUTCMinutes()
      const day = now.getUTCDay()
      if (day >= 1 && day <= 5 && m >= 12*60 && m < 16*60) oppScore += 5
    } else if (rec.direction === 'FLAT' && rec.blockers.length === 0) {
      oppScore = rec.confidence * 0.3   // FLAT senza blocker: penalty
    } else {
      oppScore = 0   // FLAT con blocker
    }

    results.push({
      symbol,
      direction: rec.direction,
      confidence: rec.confidence,
      combined: rec.combined,
      techScore: rec.techScore,
      fundScore: rec.fundScore,
      blockers: rec.blockers,
      reasons:  rec.reasons.slice(0, 3),   // top 3 reasons
      mtfAligned: mtf ? `${mtf.alignedCount}/${mtf.totalCount}` : '0/0',
      backtestWR: backtestStats?.byLabel?.[technicalSignal.label]?.winRate ?? null,
      regime: regime?.regime,
      patternCount: patterns.length,
      hasHarmonic: patterns.some(p => p.type === 'harmonic'),
      oppScore: Math.round(oppScore),
      price: inst.price ?? inst.candles[inst.candles.length - 1]?.close,
    })
  }

  return results.sort((a, b) => b.oppScore - a.oppScore)
}

// Sintesi compatta per il payload Claude — top 5 opportunità
export function summarizeScanForClaude(scanResults, currentSymbol) {
  if (!scanResults || scanResults.length === 0) return null
  const top5 = scanResults.slice(0, 5).map(r => ({
    symbol:     r.symbol,
    direction:  r.direction,
    confidence: r.confidence,
    quality:    r.oppScore,
    blocked:    r.blockers.length > 0,
    mtf:        r.mtfAligned,
    regime:     r.regime,
    backtest_wr: r.backtestWR != null ? Math.round(r.backtestWR * 100) : null,
  }))
  const current = scanResults.find(r => r.symbol === currentSymbol)
  return {
    current_symbol_rank: current
      ? scanResults.findIndex(r => r.symbol === currentSymbol) + 1
      : null,
    top_opportunities: top5,
    total_scanned: scanResults.length,
  }
}
