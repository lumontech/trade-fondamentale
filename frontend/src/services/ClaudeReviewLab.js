// ClaudeReviewLab — Self-learning loop per Claude.
// Per ogni decisione passata salvata in TradeLog, permette a Claude di:
//   1. Rivedere il setup originale alla luce dell'azione di prezzo successiva
//   2. Capire cosa ha visto correttamente e cosa ha sbagliato
//   3. Estrarre lezioni generalizzabili (italiano)
//   4. Iniettare automaticamente le lezioni nel SYSTEM_PROMPT delle prossime call
//
// Storage: localStorage namespace separato da TradeLog.
//   - itp_claude_reviews_v1: array di review {decisionId, review_json, reviewed_at, ...}
//   - itp_claude_lessons_v1: top lessons aggregate per iniezione nel prompt

import { getAllDecisions }   from './TradeLog'
import { useAppStore }        from '../store/store'
import { loadMultiTFCandles } from './DataHub'

const REVIEW_KEY  = 'itp_claude_reviews_v1'
const LESSONS_KEY = 'itp_claude_lessons_v1'
const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages'

// ── Storage helpers ────────────────────────────────────────────────
function _loadReviews() {
  try { return JSON.parse(localStorage.getItem(REVIEW_KEY) || '[]') }
  catch { return [] }
}
function _saveReviews(list) {
  try { localStorage.setItem(REVIEW_KEY, JSON.stringify(list)) }
  catch {}
}
function _loadLessons() {
  try { return JSON.parse(localStorage.getItem(LESSONS_KEY) || 'null') }
  catch { return null }
}
function _saveLessons(obj) {
  try { localStorage.setItem(LESSONS_KEY, JSON.stringify(obj)) }
  catch {}
}

export function getAllReviews()       { return _loadReviews() }
export function getReview(decisionId) { return _loadReviews().find(r => r.decisionId === decisionId) }
export function deleteReview(decisionId) {
  _saveReviews(_loadReviews().filter(r => r.decisionId !== decisionId))
}
export function clearAllReviews() { _saveReviews([]) }
export function clearLessons()    { _saveLessons(null) }

// ── REVIEW PROMPT — diverso dal SYSTEM_PROMPT principale ─────────────
const REVIEW_PROMPT = `Sei un trader istituzionale senior in modalità POST-MORTEM REVIEW.

Hai davanti una decisione di trading che HAI PRESO IN PASSATO (con il contesto del momento)
e l'azione di prezzo che è seguita. Devi valutare la qualità della tua decisione passata
con il senno di poi, ed estrarne lezioni concrete per il futuro.

Ragiona in 4 step (INTERNAMENTE):

1) **Outcome assessment**: la decisione ha funzionato? Se LONG/SHORT, è stata profittevole?
   Se FLAT, il setup poi è davvero arrivato come previsto o ho lasciato sul tavolo un trade?

2) **What I saw correctly**: quali fattori ho valutato bene? (es. trend HTF, livelli, divergenze)

3) **What I missed or got wrong**: cosa NON ho visto che era importante? Cosa ho dato troppo
   peso quando non avrei dovuto? Sono stato over/under confident?

4) **Lessons**: 1-3 lezioni GENERALIZZABILI in italiano (no "questa volta avrei dovuto X",
   ma "quando vedo Y, devo ricordarmi di Z").

REGOLE OUTPUT:
- Sii brutalmente onesto. Riconosci gli errori senza giustificarli.
- Le lezioni devono essere ACTIONABLE: "non shortare quando RSI < 30 e COT > 80% long"
  è una lezione, "stare più attento" non lo è.
- Tag breve per ogni lezione (es: "cot_extreme_contrarian", "mtf_misalignment", "early_short").

OUTPUT JSON ESATTO (rispondi SOLO con questo):
{
  "verdict_correct": "right" | "wrong" | "mixed",
  "outcome_summary": "italiano, 1-2 frasi su come è finita la decisione",
  "what_went_right": ["fattori valutati bene, max 4"],
  "what_went_wrong": ["errori o segnali mancati, max 4"],
  "confidence_calibration": "overconfident" | "underconfident" | "well-calibrated",
  "calibration_note": "1 frase: la confidence era allineata col risultato?",
  "lessons": [
    { "tag": "snake_case_short", "italian": "lezione actionable max 1 frase" }
  ],
  "would_redo_same": true | false,
  "would_redo_reason": "italiano, 1 frase"
}`

// ── Prepara payload per Claude ──────────────────────────────────────
function buildReviewPayload(decision, instruments) {
  const inst = instruments[decision.symbol]
  const candles = inst?.candles || []

  // Recent price action: prendi le candele dal momento della decisione in poi
  const decTimeSec = Math.floor(decision.openedAt / 1000)
  const closeTimeSec = decision.closedAt ? Math.floor(decision.closedAt / 1000) : Math.floor(Date.now() / 1000)
  const sinceCandles = candles.filter(c => c.time >= decTimeSec - 3600 && c.time <= closeTimeSec + 3600)

  const currentPrice = inst?.price ?? candles[candles.length - 1]?.close

  // Riassunto sintetico dei candle dopo la decisione (max 30 punti)
  const priceActionSummary = sinceCandles.length > 0 ? {
    bars_count:  sinceCandles.length,
    first_close: sinceCandles[0]?.close,
    last_close:  sinceCandles[sinceCandles.length - 1]?.close,
    max_high:    Math.max(...sinceCandles.map(c => c.high)),
    min_low:     Math.min(...sinceCandles.map(c => c.low)),
    pct_change:  sinceCandles[0]?.close
      ? ((sinceCandles[sinceCandles.length - 1].close - sinceCandles[0].close) / sinceCandles[0].close) * 100
      : null,
  } : { bars_count: 0, note: 'no candele disponibili per il periodo' }

  return {
    decision_metadata: {
      id:         decision.id,
      symbol:     decision.symbol,
      timeframe:  decision.timeframe,
      direction:  decision.direction,
      confidence: decision.confidence,
      opened_at:  new Date(decision.openedAt).toISOString(),
      closed_at:  decision.closedAt ? new Date(decision.closedAt).toISOString() : null,
      status:     decision.status,    // open | closed | dismissed
    },
    original_decision: {
      entry:       decision.entryPrice,
      stop_loss:   decision.suggestedSL,
      take_profit: decision.suggestedTP,
      reasons:     decision.reasons || [],
      blockers:    decision.blockers || [],
    },
    original_context_summary: decision.contextSnapshot ? {
      technical:           decision.contextSnapshot.technical,
      multi_timeframe:     decision.contextSnapshot.multi_timeframe,
      patterns_summary:    decision.contextSnapshot.patterns_summary,
      regime:              decision.contextSnapshot.regime,
      cot:                 decision.contextSnapshot.cot,
      market_context:      decision.contextSnapshot.market_context,
      indicators_extended: decision.contextSnapshot.indicators_extended,
    } : null,
    outcome: {
      status:      decision.status,
      exit_price:  decision.exitPrice,
      pnl_pct:     decision.pnlPct,
      r_multiple:  decision.rMultiple,
      notes:       decision.notes,
    },
    price_action_since_decision: priceActionSummary,
    current_price: currentPrice,
  }
}

// ── Review singola decisione ────────────────────────────────────────
export async function reviewDecision(decisionId, apiKey, model = 'claude-opus-4-7') {
  if (!apiKey) throw new Error('ANTHROPIC_KEY_MISSING')
  const decisions = getAllDecisions()
  const decision = decisions.find(d => d.id === decisionId)
  if (!decision) throw new Error('Decision not found: ' + decisionId)

  // Carica candele recenti se non già in store
  const state = useAppStore.getState()
  if (!state.instruments[decision.symbol]?.candles?.length) {
    try { await loadMultiTFCandles(decision.symbol) } catch (_) {}
  }
  const payload = buildReviewPayload(decision, useAppStore.getState().instruments)

  const userMsg = `Rivedi questa decisione passata e valutane qualità.\n\n${JSON.stringify(payload, null, 2)}`

  const body = {
    model,
    max_tokens: 1500,
    system: REVIEW_PROMPT,
    messages: [{ role: 'user', content: [{ type: 'text', text: userMsg }] }],
  }

  const res = await fetch(ANTHROPIC_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'anthropic-dangerous-direct-browser-access': 'true',
    },
    body: JSON.stringify(body),
  })

  if (!res.ok) {
    const errText = await res.text().catch(() => '')
    throw new Error(`Anthropic HTTP ${res.status}: ${errText.slice(0, 200)}`)
  }

  const data = await res.json()
  const text = data?.content?.[0]?.text
  if (!text) throw new Error('Empty Claude response')

  const cleaned = text.trim().replace(/^```json\s*/i, '').replace(/```\s*$/, '').trim()
  let review
  try {
    review = JSON.parse(cleaned)
  } catch (err) {
    throw new Error(`JSON parse failed: ${err.message}\nResponse: ${text.slice(0, 300)}`)
  }

  // Salva
  const all = _loadReviews()
  const filtered = all.filter(r => r.decisionId !== decisionId)
  filtered.unshift({
    decisionId,
    reviewed_at: Date.now(),
    model,
    review,
    usage: data.usage,
  })
  _saveReviews(filtered)

  return review
}

// ── Batch review delle ultime N decisioni ───────────────────────────
export async function reviewLastN(n, apiKey, model = 'claude-opus-4-7', onProgress = null) {
  const all = getAllDecisions().slice(0, n)
  const results = []
  for (let i = 0; i < all.length; i++) {
    if (onProgress) onProgress({ current: i + 1, total: all.length, decision: all[i] })
    try {
      const r = await reviewDecision(all[i].id, apiKey, model)
      results.push({ id: all[i].id, ok: true, review: r })
    } catch (err) {
      results.push({ id: all[i].id, ok: false, error: err.message })
    }
    // Rate-limit Anthropic: pausa 500ms tra le call
    if (i < all.length - 1) await new Promise(r => setTimeout(r, 500))
  }
  return results
}

// ── Aggregate report da tutte le review ─────────────────────────────
export function aggregateReport() {
  const reviews = _loadReviews()
  if (reviews.length === 0) return null

  const decisions = getAllDecisions()
  const decById = Object.fromEntries(decisions.map(d => [d.id, d]))

  let right = 0, wrong = 0, mixed = 0
  let over = 0, under = 0, calibrated = 0
  const lessonCounts = new Map()   // tag → count + sample italian
  const bySymbol = {}              // symbol → {total, right, wrong}
  const byDirection = { LONG: { total: 0, right: 0 }, SHORT: { total: 0, right: 0 }, FLAT: { total: 0, right: 0 } }

  for (const r of reviews) {
    const v = r.review
    if (!v) continue
    if (v.verdict_correct === 'right') right++
    else if (v.verdict_correct === 'wrong') wrong++
    else mixed++

    if (v.confidence_calibration === 'overconfident') over++
    else if (v.confidence_calibration === 'underconfident') under++
    else calibrated++

    for (const lesson of (v.lessons || [])) {
      const tag = lesson.tag || 'untagged'
      const prev = lessonCounts.get(tag)
      if (prev) {
        prev.count++
      } else {
        lessonCounts.set(tag, { count: 1, italian: lesson.italian, tag })
      }
    }

    const dec = decById[r.decisionId]
    if (dec) {
      const s = bySymbol[dec.symbol] = bySymbol[dec.symbol] || { total: 0, right: 0, wrong: 0 }
      s.total++
      if (v.verdict_correct === 'right') s.right++
      if (v.verdict_correct === 'wrong') s.wrong++

      if (byDirection[dec.direction]) {
        byDirection[dec.direction].total++
        if (v.verdict_correct === 'right') byDirection[dec.direction].right++
      }
    }
  }

  const topLessons = [...lessonCounts.values()]
    .sort((a, b) => b.count - a.count)
    .slice(0, 10)

  return {
    total_reviews: reviews.length,
    right, wrong, mixed,
    accuracy_pct: reviews.length > 0 ? Math.round((right / reviews.length) * 100) : 0,
    confidence_calibration: {
      overconfident: over,
      underconfident: under,
      well_calibrated: calibrated,
      dominant: over > under && over > calibrated ? 'overconfident'
              : under > over && under > calibrated ? 'underconfident'
              : 'well-calibrated',
    },
    top_lessons: topLessons,
    by_symbol: bySymbol,
    by_direction: byDirection,
    last_reviewed_at: Math.max(...reviews.map(r => r.reviewed_at)),
  }
}

// ── Estrai lessons per iniezione nel SYSTEM_PROMPT ──────────────────
// Le top-N lezioni più ricorrenti vengono salvate e iniettate
export function rebuildLessons() {
  const report = aggregateReport()
  if (!report) { _saveLessons(null); return null }
  const lessons = (report.top_lessons || []).slice(0, 8).map(l => l.italian)
  const summary = {
    updated_at: Date.now(),
    accuracy_pct: report.accuracy_pct,
    calibration: report.confidence_calibration.dominant,
    lessons,
    stats_note: `${report.total_reviews} review · ${report.right} corrette / ${report.wrong} errate / ${report.mixed} miste`,
  }
  _saveLessons(summary)
  return summary
}

export function getLessons() { return _loadLessons() }

// ── Testo formattato da iniettare nel SYSTEM_PROMPT ─────────────────
export function buildLessonsPromptAddon() {
  const lessons = _loadLessons()
  if (!lessons || !lessons.lessons?.length) return ''
  const ln = lessons.lessons.map((l, i) => `${i + 1}. ${l}`).join('\n')
  return `

## LEZIONI APPRESE DA REVIEW DELLE TUE DECISIONI PASSATE (${lessons.stats_note})

La tua calibrazione confidence è: **${lessons.calibration}**. ${lessons.calibration === 'overconfident' ? 'Riduci la confidence di 10-15 punti rispetto al tuo istinto.' : lessons.calibration === 'underconfident' ? 'Puoi alzare la confidence di 5-10 punti quando i fattori sono solidi.' : 'La tua calibrazione è buona, mantienila.'}

Quando analizzi un nuovo setup, ricorda queste regole estratte dai tuoi errori passati:
${ln}

Se la situazione attuale ricorda una delle lezioni sopra, citala ESPLICITAMENTE in "reasoning"
(es. "Lezione 3 applicata: ho ridotto la confidence perché RSI < 30 + COT > 80% long").`
}
