// MTF Chart Capture v2 — Trader Pro Mode
// Genera 5 immagini per Claude Vision:
//   1. CONTEXT panel (RSI/MACD/BB/MTF/Regime/COT + Macro sentiment)
//   2. Chart 1D (3-pane: candles+EMA+VP / RSI / MACD)
//   3. Chart 4h (3-pane)
//   4. Chart 1h (3-pane)
//   5. Chart 15m (3-pane)
//
// Ogni chart contiene tutto quello che vede un trader pro su TradingView Pro:
// - Candele OHLC
// - EMA50/200 (trend macro)
// - Bollinger Bands (volatility envelope)
// - Volume Profile POC/VAH/VAL (priceLines orizzontali)
// - Fibonacci 38.2/50/61.8/78.6
// - Trendlines auto-detect (max 3)
// - Pattern markers (frecce up/down per detect pattern)
// - RSI sub-pane con linee 30/50/70
// - MACD sub-pane con histogram colorato

import { createChart, CrosshairMode } from 'lightweight-charts'
import { calculateEMA } from '../utils/indicators'
import { detectTrendlines } from './TrendlinesEngine'
import { calculateVolumeProfile } from './VolumeProfile'
import { calculateFibonacci } from './IndicatorsExtended'
import { detectAllPatterns } from './PatternsEngine'
import html2canvas from 'html2canvas'

const TF_LABELS = { '1m': '1 minuto', '5m': '5 minuti', '15m': '15 minuti', '1h': '1 ora', '4h': '4 ore', '1D': 'Giornaliero' }

// Preset TF list per modalità diverse di analisi.
// Intraday/swing: 1D → 4h → 1h → 15m (top-down Murphy classico)
// Scalping:       1h → 15m → 1m       (focus micro-timing entry)
export const TF_PRESETS = {
  intraday: ['1D', '4h', '1h', '15m'],
  scalping: ['1h', '15m', '1m'],
}

// ── Calcolo RSI / MACD per pane secondari (in-line, no dep esterne) ────────
function calcRSISeries(candles, period = 14) {
  if (candles.length < period + 1) return []
  const out = []
  let gain = 0, loss = 0
  for (let i = 1; i <= period; i++) {
    const d = candles[i].close - candles[i - 1].close
    if (d > 0) gain += d; else loss -= d
  }
  let avgG = gain / period, avgL = loss / period
  out.push({ time: candles[period].time, value: avgL === 0 ? 100 : 100 - 100 / (1 + avgG / avgL) })
  for (let i = period + 1; i < candles.length; i++) {
    const d = candles[i].close - candles[i - 1].close
    avgG = (avgG * (period - 1) + Math.max(0, d)) / period
    avgL = (avgL * (period - 1) + Math.max(0, -d)) / period
    out.push({ time: candles[i].time, value: avgL === 0 ? 100 : 100 - 100 / (1 + avgG / avgL) })
  }
  return out
}

function calcMACDSeries(candles, fast = 12, slow = 26, sig = 9) {
  if (candles.length < slow + sig) return { hist: [], signal: [] }
  const ema = (data, p) => {
    if (data.length < p) return []
    const k = 2 / (p + 1)
    let v = 0
    for (let i = 0; i < p; i++) v += data[i]
    v /= p
    const out = [v]
    for (let i = p; i < data.length; i++) { v = data[i] * k + v * (1 - k); out.push(v) }
    return out
  }
  const closes = candles.map(c => c.close)
  const eFast = ema(closes, fast)
  const eSlow = ema(closes, slow)
  const offset = slow - fast
  const macdLine = eFast.slice(offset).map((v, i) => v - eSlow[i])
  const sigLine = ema(macdLine, sig)
  // macdLine inizia all'indice (slow-1) di candles; sigLine all'indice (slow-1 + sig-1)
  const startIdx = slow - 1 + sig - 1
  const hist = [], signal = []
  for (let i = 0; i < sigLine.length; i++) {
    const t = candles[startIdx + i]?.time
    if (t == null) break
    const h = macdLine[sig - 1 + i] - sigLine[i]
    hist.push({ time: t, value: h, color: h >= 0 ? '#00e09680' : '#ff335580' })
    signal.push({ time: t, value: sigLine[i] })
  }
  return { hist, signal }
}

function buildContainer() {
  const wrap = document.createElement('div')
  wrap.style.cssText = `
    position: fixed; left: -10000px; top: 0; width: 1100px; height: auto;
    background: #04060a; color: #d8dee9; font-family: 'IBM Plex Mono', monospace;
    padding: 16px; z-index: -1;
  `
  document.body.appendChild(wrap)
  return wrap
}

// Renderizza un PANEL multi-pane per un singolo TF (candle + RSI + MACD impilati)
// Ritorna { charts, panel, slice, lastValues } per permettere alla pipeline
// di chiamare chart.takeScreenshot() e comporre il master canvas.
function renderTFPanel(parent, { symbol, tf, candles, label }) {
  const panel = document.createElement('div')
  panel.style.cssText = `width: 1068px; margin-bottom: 18px;`
  parent.appendChild(panel)

  const slice = candles.slice(-200)
  const last = slice[slice.length - 1]
  const tzShift = -new Date().getTimezoneOffset() * 60
  const charts = []

  // ── PANE 1: candle + EMA + BB + VP + trendlines + patterns ───────────────
  const div1 = document.createElement('div')
  div1.style.cssText = `width: 100%; height: 260px;`
  panel.appendChild(div1)

  const chart1 = createChart(div1, {
    width: 1068, height: 260,
    layout: { background: { type: 'solid', color: '#04060a' }, textColor: '#8892a4', fontSize: 11 },
    grid: { vertLines: { color: '#1e2535' }, horzLines: { color: '#1e2535' } },
    crosshair: { mode: CrosshairMode.Normal },
    rightPriceScale: { borderColor: '#1e2535' },
    timeScale: { borderColor: '#1e2535', timeVisible: true, secondsVisible: false, visible: false },
  })

  const candleSeries = chart1.addCandlestickSeries({
    upColor: '#00e096', downColor: '#ff3355',
    borderUpColor: '#00e096', borderDownColor: '#ff3355',
    wickUpColor: '#00e096', wickDownColor: '#ff3355',
  })
  candleSeries.setData(slice.map(c => ({ ...c, time: c.time + tzShift })))

  // Volume bars come histogram interno
  const volSeries = chart1.addHistogramSeries({
    priceFormat: { type: 'volume' },
    priceScaleId: 'vol',
    scaleMargins: { top: 0.85, bottom: 0 },
  })
  chart1.priceScale('vol').applyOptions({ scaleMargins: { top: 0.85, bottom: 0 } })
  volSeries.setData(slice.map(c => ({
    time: c.time + tzShift,
    value: c.volume || 0,
    color: c.close >= c.open ? '#00e09633' : '#ff335533',
  })))

  // EMA50 (orange) + EMA200 (purple)
  try {
    const ema50 = calculateEMA(slice, 50)
    if (ema50.length > 0) {
      const e50 = chart1.addLineSeries({ color: '#FF9800', lineWidth: 1, priceLineVisible: false, lastValueVisible: false })
      e50.setData(ema50.map(p => ({ ...p, time: p.time + tzShift })))
    }
    const ema200 = calculateEMA(slice, 200)
    if (ema200.length > 0) {
      const e200 = chart1.addLineSeries({ color: '#9C27B0', lineWidth: 2, priceLineVisible: false, lastValueVisible: false })
      e200.setData(ema200.map(p => ({ ...p, time: p.time + tzShift })))
    }
  } catch (_) {}

  // Bollinger Bands (period 20, 2 std)
  try {
    const period = 20
    const mult = 2
    const bbUpper = [], bbMid = [], bbLower = []
    for (let i = period - 1; i < slice.length; i++) {
      let sum = 0
      for (let j = i - period + 1; j <= i; j++) sum += slice[j].close
      const mean = sum / period
      let varSum = 0
      for (let j = i - period + 1; j <= i; j++) varSum += (slice[j].close - mean) ** 2
      const std = Math.sqrt(varSum / period)
      bbUpper.push({ time: slice[i].time + tzShift, value: mean + mult * std })
      bbMid.push({   time: slice[i].time + tzShift, value: mean })
      bbLower.push({ time: slice[i].time + tzShift, value: mean - mult * std })
    }
    const s1 = chart1.addLineSeries({ color: '#5a6478', lineWidth: 1, lineStyle: 2, priceLineVisible: false, lastValueVisible: false })
    s1.setData(bbUpper)
    const s2 = chart1.addLineSeries({ color: '#5a647855', lineWidth: 1, lineStyle: 2, priceLineVisible: false, lastValueVisible: false })
    s2.setData(bbLower)
  } catch (_) {}

  // Volume Profile (POC/VAH/VAL)
  try {
    const vp = calculateVolumeProfile(slice, 60, 25)
    if (vp) {
      candleSeries.createPriceLine({ price: vp.poc, color: '#f5c842', lineWidth: 2, lineStyle: 2, axisLabelVisible: true, title: 'POC' })
      candleSeries.createPriceLine({ price: vp.vah, color: '#00e09680', lineWidth: 1, lineStyle: 3, axisLabelVisible: true, title: 'VAH' })
      candleSeries.createPriceLine({ price: vp.val, color: '#ff335580', lineWidth: 1, lineStyle: 3, axisLabelVisible: true, title: 'VAL' })
    }
  } catch (_) {}

  // Fibonacci
  try {
    const fib = calculateFibonacci(slice, 80)
    if (fib?.retracement) {
      for (const lvl of fib.retracement) {
        if ([0.382, 0.5, 0.618, 0.786].includes(lvl.ratio)) {
          candleSeries.createPriceLine({
            price: lvl.price,
            color: lvl.ratio === 0.618 ? '#cc785cdd' : '#cc785c80',
            lineWidth: lvl.ratio === 0.618 ? 2 : 1,
            lineStyle: 1, axisLabelVisible: true,
            title: `Fib ${(lvl.ratio * 100).toFixed(1)}%`,
          })
        }
      }
    }
  } catch (_) {}

  // Trendlines
  try {
    const tlines = detectTrendlines(slice, 80, 3).slice(0, 3)
    for (const tl of tlines) {
      const s = chart1.addLineSeries({
        color: tl.type === 'resistance' ? '#ff335580' : '#00e09680',
        lineWidth: tl.strength === 'major' ? 2 : 1,
        lineStyle: tl.broken ? 3 : 0,
        priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false,
      })
      s.setData([
        { time: tl.from_time + tzShift, value: tl.from_price },
        { time: tl.to_time + tzShift, value: tl.to_price },
      ])
    }
  } catch (_) {}

  // Pattern markers
  try {
    const pats = detectAllPatterns(slice).slice(0, 6)
    const markers = pats.filter(p => p.time != null).map(p => ({
      time: p.time + tzShift,
      position: p.bias === 'bullish' ? 'belowBar' : 'aboveBar',
      color: p.bias === 'bullish' ? '#00e096' : p.bias === 'bearish' ? '#ff3355' : '#f5c842',
      shape: p.bias === 'bullish' ? 'arrowUp' : 'arrowDown',
      text: (p.italian || p.name || '').split(' ')[0],
      size: 1,
    })).sort((a, b) => a.time - b.time)
    candleSeries.setMarkers(markers)
  } catch (_) {}

  chart1.timeScale().fitContent()
  charts.push(chart1)

  // ── PANE 2: RSI ────────────────────────────────────────────────────────
  const div2 = document.createElement('div')
  div2.style.cssText = `width: 100%; height: 90px; margin-top: -1px;`
  panel.appendChild(div2)
  const chart2 = createChart(div2, {
    width: 1068, height: 90,
    layout: { background: { type: 'solid', color: '#04060a' }, textColor: '#8892a4', fontSize: 10 },
    grid: { vertLines: { color: '#1e253566' }, horzLines: { color: '#1e253566' } },
    crosshair: { mode: CrosshairMode.Normal },
    rightPriceScale: { borderColor: '#1e2535', autoScale: false, minimumWidth: 50 },
    timeScale: { borderColor: '#1e2535', timeVisible: true, visible: false },
  })
  const rsiData = calcRSISeries(slice, 14).map(p => ({ ...p, time: p.time + tzShift }))
  let rsiLast = null
  if (rsiData.length) {
    const rsiSeries = chart2.addLineSeries({ color: '#82aaff', lineWidth: 2, priceLineVisible: false, lastValueVisible: true })
    rsiSeries.setData(rsiData)
    rsiSeries.createPriceLine({ price: 70, color: '#ff335577', lineWidth: 1, lineStyle: 2, axisLabelVisible: true, title: '70' })
    rsiSeries.createPriceLine({ price: 30, color: '#00e09677', lineWidth: 1, lineStyle: 2, axisLabelVisible: true, title: '30' })
    rsiSeries.createPriceLine({ price: 50, color: '#5a647855', lineWidth: 1, lineStyle: 3, axisLabelVisible: false })
    rsiLast = rsiData[rsiData.length - 1].value
  }
  chart2.timeScale().fitContent()
  charts.push(chart2)

  // ── PANE 3: MACD ───────────────────────────────────────────────────────
  const div3 = document.createElement('div')
  div3.style.cssText = `width: 100%; height: 90px; margin-top: -1px;`
  panel.appendChild(div3)
  const chart3 = createChart(div3, {
    width: 1068, height: 90,
    layout: { background: { type: 'solid', color: '#04060a' }, textColor: '#8892a4', fontSize: 10 },
    grid: { vertLines: { color: '#1e253566' }, horzLines: { color: '#1e253566' } },
    rightPriceScale: { borderColor: '#1e2535', minimumWidth: 50 },
    timeScale: { borderColor: '#1e2535', timeVisible: true, visible: true },
  })
  const macd = calcMACDSeries(slice)
  let macdLast = null
  if (macd.hist.length) {
    const histSeries = chart3.addHistogramSeries({ color: '#5a6478', priceLineVisible: false })
    histSeries.setData(macd.hist.map(p => ({ ...p, time: p.time + tzShift })))
    const sigSeries = chart3.addLineSeries({ color: '#f5c842', lineWidth: 1, priceLineVisible: false, lastValueVisible: false })
    sigSeries.setData(macd.signal.map(p => ({ ...p, time: p.time + tzShift })))
    macdLast = macd.hist[macd.hist.length - 1].value
  }
  chart3.timeScale().fitContent()
  charts.push(chart3)

  return { charts, panel, slice, last, rsiLast, macdLast }
}

// Compone un master canvas con header text + 3 chart.takeScreenshot() impilati.
// Risolve il bug html2canvas (non legge il canvas dei chart lightweight-charts).
function composeTFCanvas({ symbol, tf, label, slice, last, charts, rsiLast, macdLast }) {
  const W = 1068
  const HEADER_H = 32
  const C1_H = 260
  const C2_H = 90
  const C3_H = 90
  const SUB_LABEL_H = 16
  const totalH = HEADER_H + C1_H + SUB_LABEL_H + C2_H + SUB_LABEL_H + C3_H

  const dpr = 2 // 2× per leggibilità — Anthropic Vision rescala comunque
  const canvas = document.createElement('canvas')
  canvas.width  = W * dpr
  canvas.height = totalH * dpr
  const ctx = canvas.getContext('2d')
  ctx.scale(dpr, dpr)
  ctx.imageSmoothingEnabled = true
  ctx.imageSmoothingQuality = 'high'

  // Background
  ctx.fillStyle = '#04060a'
  ctx.fillRect(0, 0, W, totalH)

  // Header
  ctx.fillStyle = '#f5c842'
  ctx.font = 'bold 16px "IBM Plex Mono", monospace'
  ctx.textBaseline = 'middle'
  ctx.fillText(`${symbol} · ${label} (${tf})`, 10, HEADER_H / 2)
  ctx.fillStyle = '#8892a4'
  ctx.font = '12px "IBM Plex Mono", monospace'
  ctx.textAlign = 'right'
  ctx.fillText(`${slice.length} bar · last: ${last?.close?.toFixed?.(4) ?? '—'}`, W - 10, HEADER_H / 2)
  ctx.textAlign = 'left'

  // PANE 1: price
  const sc1 = charts[0].takeScreenshot()
  ctx.drawImage(sc1, 0, 0, sc1.width, sc1.height, 0, HEADER_H, W, C1_H)

  // Label RSI
  ctx.fillStyle = '#82aaff'
  ctx.font = 'bold 11px "IBM Plex Mono", monospace'
  ctx.fillText(`RSI(14) ${rsiLast != null ? rsiLast.toFixed(1) : '—'}`, 10, HEADER_H + C1_H + SUB_LABEL_H / 2)

  // PANE 2: RSI
  const sc2 = charts[1].takeScreenshot()
  ctx.drawImage(sc2, 0, 0, sc2.width, sc2.height, 0, HEADER_H + C1_H + SUB_LABEL_H, W, C2_H)

  // Label MACD
  ctx.fillStyle = '#f5c842'
  ctx.fillText(`MACD(12,26,9) ${macdLast != null ? macdLast.toFixed(5) : '—'}`, 10, HEADER_H + C1_H + SUB_LABEL_H + C2_H + SUB_LABEL_H / 2)

  // PANE 3: MACD
  const sc3 = charts[2].takeScreenshot()
  ctx.drawImage(sc3, 0, 0, sc3.width, sc3.height, 0, HEADER_H + C1_H + SUB_LABEL_H + C2_H + SUB_LABEL_H, W, C3_H)

  return canvas.toDataURL('image/png').split(',')[1]
}

// Context panel testuale con tutti i dati macro
function renderContextPanel(parent, ctxPack) {
  const div = document.createElement('div')
  div.style.cssText = `background: #0a0e16; padding: 14px 18px; border: 1px solid #1e2535; border-radius: 4px; margin-bottom: 12px;`
  div.innerHTML = `
    <div style="color:#f5c842;font-weight:600;margin-bottom:10px;font-size:14px;">Context macro + indicatori sintetici</div>
    <div style="display:grid;grid-template-columns:repeat(4,1fr);gap:12px;font-size:12px;">
      <div>
        <div style="color:#8892a4;font-size:10px;">RSI(14)</div>
        <div style="color:#fff;font-size:16px;font-weight:600;">${ctxPack?.technical?.rsi?.value ?? '—'}</div>
        <div style="color:${ctxPack?.technical?.rsi?.state === 'oversold' ? '#00e096' : ctxPack?.technical?.rsi?.state === 'overbought' ? '#ff3355' : '#8892a4'};font-size:10px;">${ctxPack?.technical?.rsi?.state ?? '—'}</div>
      </div>
      <div>
        <div style="color:#8892a4;font-size:10px;">MACD</div>
        <div style="color:#fff;font-size:13px;">${ctxPack?.technical?.macd?.trend ?? '—'}</div>
        <div style="color:#8892a4;font-size:10px;">${ctxPack?.technical?.macd?.momentum ?? '—'}</div>
      </div>
      <div>
        <div style="color:#8892a4;font-size:10px;">Bollinger</div>
        <div style="color:#fff;font-size:13px;">${ctxPack?.technical?.bb?.position ?? '—'}</div>
        <div style="color:#8892a4;font-size:10px;">w ${ctxPack?.technical?.bb?.bandwidth_pct ?? '—'}%</div>
      </div>
      <div>
        <div style="color:#8892a4;font-size:10px;">MTF Alignment</div>
        <div style="color:#fff;font-size:13px;">${ctxPack?.multi_timeframe?.alignment_score ?? '—'}/4</div>
        <div style="color:#8892a4;font-size:10px;">${(ctxPack?.multi_timeframe?.summary || '').slice(0, 40)}</div>
      </div>
      <div>
        <div style="color:#8892a4;font-size:10px;">COT positioning</div>
        <div style="color:#fff;font-size:13px;">${ctxPack?.cot?.sentiment ?? '—'}</div>
        <div style="color:#8892a4;font-size:10px;">${ctxPack?.cot?.pct_long != null ? (ctxPack.cot.pct_long * 100).toFixed(0) + '% long NC' : '—'}</div>
      </div>
      <div>
        <div style="color:#8892a4;font-size:10px;">F&amp;G Index</div>
        <div style="color:#fff;font-size:13px;">${ctxPack?.market_context?.fear_greed?.value ?? '—'}</div>
        <div style="color:#8892a4;font-size:10px;">${ctxPack?.market_context?.fear_greed?.label ?? '—'}</div>
      </div>
      <div>
        <div style="color:#8892a4;font-size:10px;">DXY / VIX</div>
        <div style="color:#fff;font-size:13px;">${ctxPack?.market_context?.dxy ?? '—'} / ${ctxPack?.market_context?.vix ?? '—'}</div>
        <div style="color:#8892a4;font-size:10px;">US10Y ${ctxPack?.market_context?.us10y?.value ?? '—'}</div>
      </div>
      <div>
        <div style="color:#8892a4;font-size:10px;">Volatility regime</div>
        <div style="color:#fff;font-size:13px;">${ctxPack?.regime?.regime ?? '—'}</div>
        <div style="color:#8892a4;font-size:10px;">ATR ${ctxPack?.indicators_extended?.atr?.value ?? '—'}</div>
      </div>
    </div>
    <div style="margin-top:12px;padding-top:8px;border-top:1px solid #1e2535;font-size:11px;color:#d8dee9;">
      <div style="margin-bottom:4px;color:#f5c842;font-weight:600;">Patterns rilevati dall'algoritmo:</div>
      <div>${(() => {
        const raw = ctxPack?.patterns_summary?.active
        const arr = Array.isArray(raw) ? raw.slice(0, 6) : []
        return arr.length ? arr.map(p => `<span style="display:inline-block;background:#161b27;color:#fff;padding:2px 8px;border-radius:3px;margin:2px;">${p}</span>`).join('') : '<span style="color:#8892a4;">nessuno</span>'
      })()}</div>
    </div>
    <div style="margin-top:10px;font-size:11px;color:#d8dee9;">
      <div style="margin-bottom:4px;color:#f5c842;font-weight:600;">Trendlines auto-detect:</div>
      <div>${(() => {
        const raw = ctxPack?.trendlines
        const arr = Array.isArray(raw) ? raw : (Array.isArray(raw?.lines) ? raw.lines : [])
        const sliced = arr.slice(0, 3)
        return sliced.length ? sliced.map(t => `<span style="color:${t.type === 'support' ? '#00e096' : '#ff3355'}">▸ ${t.type} @ ${t.projected_price?.toFixed?.(4) ?? '—'} (${t.touches}t, ${t.strength}${t.broken ? ' BROKEN' : ''})</span>`).join('<br/>') : '<span style="color:#8892a4;">nessuna</span>'
      })()}</div>
    </div>
    <div style="margin-top:10px;font-size:11px;color:#d8dee9;">
      <div style="margin-bottom:4px;color:#f5c842;font-weight:600;">Currency strength (top/bottom 3):</div>
      <div>${(() => {
        const ranked = ctxPack?.currency_strength?.ranked
        if (!Array.isArray(ranked) || ranked.length === 0) return '<span style="color:#8892a4;">n/a</span>'
        const top = ranked.slice(0, 3).map(c => `<span style="color:#00e096;">${c.currency} ${c.strength?.toFixed?.(2) ?? c.strength}</span>`).join(' · ')
        const bot = ranked.slice(-3).reverse().map(c => `<span style="color:#ff3355;">${c.currency} ${c.strength?.toFixed?.(2) ?? c.strength}</span>`).join(' · ')
        return `↑ ${top} &nbsp;&nbsp;|&nbsp;&nbsp; ↓ ${bot}`
      })()}</div>
    </div>
  `
  parent.appendChild(div)
  return div
}

/**
 * Cattura le immagini Visual MTF per il prompt Claude.
 * @param {object} opts
 * @param {string} opts.symbol         es. 'XAUUSD'
 * @param {object} opts.instruments    store.instruments
 * @param {object} opts.contextPack    output di buildContextPack()
 * @param {string[]} [opts.tfs]        lista TF da catturare (default: intraday).
 *                                     Esempi: TF_PRESETS.intraday | TF_PRESETS.scalping
 * @param {string} [opts.headerLabel]  override del titolo dell'header (default 'Trader Pro')
 */
export async function captureMTFCharts({ symbol, instruments, contextPack, tfs, headerLabel }) {
  const inst = instruments[symbol]
  if (!inst) throw new Error('No instrument data')
  const mtf = inst.mtf || {}
  const mainCandles = Array.isArray(inst.candles) ? inst.candles : []

  const tfList = Array.isArray(tfs) && tfs.length ? tfs : TF_PRESETS.intraday

  const pickArr = (a) => Array.isArray(a) ? a : []
  // Costruisco lo store TF→candles dinamicamente in base ai TF richiesti.
  const data = {}
  for (const tf of tfList) {
    data[tf] = pickArr(mtf[tf]).length
      ? pickArr(mtf[tf])
      : (contextPack?.meta?.timeframe === tf ? mainCandles : [])
  }

  const container = buildContainer()
  const results = []

  try {
    // Header
    const head = document.createElement('div')
    head.style.cssText = `font-size: 20px; color: #f5c842; font-weight: 700; margin-bottom: 10px;`
    head.textContent = `${headerLabel || 'Multi-Timeframe Analysis Trader Pro'} — ${symbol} [${tfList.join(' / ')}]`
    container.appendChild(head)

    // CONTEXT (1 immagine dedicata)
    const ctxWrap = document.createElement('div')
    container.appendChild(ctxWrap)
    renderContextPanel(ctxWrap, contextPack)
    const ctxCanvas = await html2canvas(ctxWrap, { backgroundColor: '#04060a', scale: 1.5, logging: false })
    results.push({ tf: 'context', base64: ctxCanvas.toDataURL('image/png').split(',')[1] })

    // Ogni TF: usa chart.takeScreenshot() di lightweight-charts (NON html2canvas,
    // che non sa leggere il canvas dei chart e produce immagini vuote).
    for (const tf of tfList) {
      if (!data[tf] || data[tf].length < 30) continue
      const r = renderTFPanel(container, { symbol, tf, candles: data[tf], label: TF_LABELS[tf] || tf })
      // Forza il layout + un paio di frame per assicurarsi che tutti i chart
      // abbiano completato il rendering prima di chiamare takeScreenshot.
      void r.panel.offsetHeight
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))
      await new Promise(resolve => setTimeout(resolve, 250))
      try {
        const base64 = composeTFCanvas({
          symbol, tf, label: TF_LABELS[tf] || tf,
          slice: r.slice, last: r.last, charts: r.charts,
          rsiLast: r.rsiLast, macdLast: r.macdLast,
        })
        results.push({ tf, base64 })
      } catch (err) {
        console.warn(`[MTFCapture ${tf}] errore takeScreenshot:`, err.message)
      }
      r.charts.forEach(c => c.remove())
    }
  } finally {
    if (container.parentNode) container.parentNode.removeChild(container)
  }

  // Limita a 5 immagini (Anthropic Vision API max)
  return results.slice(0, 5)
}
