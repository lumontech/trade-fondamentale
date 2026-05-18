// Backtest standalone Confluence Tracker
// Usa Yahoo Finance via il modulo yahooDataSource.js esistente (no chiavi).
// Simula entry/exit con SL/TP 1.5/4.0 × ATR e costi spread fissi per asset class.
//
// Run: node scripts/backtest_confluence.mjs

import { yahooFetchCandles } from '../server/src/yahooDataSource.js'
import { STRATEGIES, atrAt } from '../server/src/strategies.js'

// Asset whitelist basata sull'audit del DB: pair che hanno mostrato un edge positivo o piccolo loss
const SYMBOLS = ['EURUSD', 'GBPUSD', 'USDJPY', 'GBPJPY', 'EURGBP', 'EURJPY', 'XAUUSD']
// USDC pair (BTCUSDC ecc.) non sono coperti da Yahoo — backtest separato via Binance se serve
const TF = '4h'
const COUNT = 1500   // ~1 anno di candele 4h

// Costo diretto in unità R (frazione del R atteso, già normalizzato)
// Forex spread 0.5-1 pip ≈ 0.05 R (con SL 20 pips)
// XAU spread $0.30 ≈ 0.10 R (con SL $3)
const COST_R = {
  EURUSD: 0.05, GBPUSD: 0.05, USDJPY: 0.05,
  GBPJPY: 0.06, EURGBP: 0.06, EURJPY: 0.05,
  XAUUSD: 0.10,
}

function simulate(candles, strat, slMul, tpMul, costR) {
  const trades = []
  let i = 200  // burn-in per indicatori
  while (i < candles.length - 1) {
    const signal = strat(candles, i)
    if (!signal) { i++; continue }
    const entry = candles[i].close
    const a = atrAt(candles, 14, i)
    if (!a) { i++; continue }
    const sl = signal.direction === 'long' ? entry - slMul * a : entry + slMul * a
    const tp = signal.direction === 'long' ? entry + tpMul * a : entry - tpMul * a
    // Simula la barra successiva fino a hit SL o TP
    let exitPrice = null, exitIdx = null, outcome = null
    for (let j = i + 1; j < Math.min(i + 100, candles.length); j++) {
      const bar = candles[j]
      if (signal.direction === 'long') {
        if (bar.low <= sl) { exitPrice = sl; exitIdx = j; outcome = 'loss'; break }
        if (bar.high >= tp) { exitPrice = tp; exitIdx = j; outcome = 'win'; break }
      } else {
        if (bar.high >= sl) { exitPrice = sl; exitIdx = j; outcome = 'loss'; break }
        if (bar.low <= tp) { exitPrice = tp; exitIdx = j; outcome = 'win'; break }
      }
    }
    if (exitPrice == null) {
      // time-out 100 bar: chiudi al close
      exitPrice = candles[Math.min(i + 100, candles.length - 1)].close
      exitIdx = Math.min(i + 100, candles.length - 1)
      outcome = (signal.direction === 'long' ? (exitPrice > entry) : (exitPrice < entry)) ? 'win' : 'loss'
    }
    const grossR = signal.direction === 'long'
      ? (exitPrice - entry) / (entry - sl)
      : (entry - exitPrice) / (sl - entry)
    const netR = grossR - costR    // costR già normalizzato in R-units
    trades.push({ entry, exit: exitPrice, dir: signal.direction, grossR, netR, outcome, entryTime: candles[i].time, exitTime: candles[exitIdx].time })
    i = exitIdx + 1   // niente sovrapposizione: no entry mentre c'è già posizione aperta
  }
  return trades
}

function stats(trades) {
  if (trades.length === 0) return { trades: 0 }
  const wins = trades.filter(t => t.netR > 0).length
  const losses = trades.length - wins
  const wr = wins / trades.length
  const totalR = trades.reduce((s, t) => s + t.netR, 0)
  const avgR = totalR / trades.length
  const sumWin = trades.filter(t => t.netR > 0).reduce((s, t) => s + t.netR, 0)
  const sumLoss = trades.filter(t => t.netR < 0).reduce((s, t) => s - t.netR, 0)
  const pf = sumLoss > 0 ? sumWin / sumLoss : (sumWin > 0 ? Infinity : 0)
  // Equity curve & max drawdown
  let eq = 0, peak = 0, maxDD = 0
  for (const t of trades) {
    eq += t.netR
    if (eq > peak) peak = eq
    const dd = peak - eq
    if (dd > maxDD) maxDD = dd
  }
  // Sharpe semplificato (sui R per trade, no rfr)
  const mean = avgR
  const variance = trades.reduce((s, t) => s + (t.netR - mean) ** 2, 0) / trades.length
  const std = Math.sqrt(variance)
  const sharpe = std > 0 ? mean / std * Math.sqrt(trades.length) : 0
  return {
    trades: trades.length, wins, losses,
    winRate: (wr * 100).toFixed(1) + '%',
    avgR: avgR.toFixed(3),
    totalR: totalR.toFixed(2),
    profitFactor: pf === Infinity ? '∞' : pf.toFixed(2),
    maxDD_R: maxDD.toFixed(2),
    sharpe: sharpe.toFixed(2),
  }
}

async function main() {
  const strategyIds = process.argv[2] ? [process.argv[2]] : ['confluenceTracker', 'rsiDivergence', 'macdDivergence', 'headShoulders', 'doubleTopBottom']
  for (const sid of strategyIds) {
    const strat = STRATEGIES.find(s => s.id === sid)   // skip enabled check for backtest
    if (!strat) { console.error(`Strategy ${sid} not found`); continue }
    console.log(`\n========================================`)
    console.log(`=== ${strat.name} Backtest ===`)
    console.log(`TF: ${TF}, ${COUNT} bar, SL/TP: ${strat.slMul}/${strat.tpMul} × ATR`)
    console.log(`========================================`)
    await runBacktestForStrategy(strat)
  }
}

async function runBacktestForStrategy(strat) {

  const results = {}
  let allTrades = []

  for (const sym of SYMBOLS) {
    try {
      const r = await yahooFetchCandles(sym, TF, COUNT)
      const candles = r.candles
      if (!candles || candles.length < 250) {
        console.log(`[${sym}] insufficient data (${candles?.length || 0})`)
        continue
      }
      const costR = COST_R[sym] || 0.05
      const trades = simulate(candles, strat.fn, strat.slMul, strat.tpMul, costR)
      const s = stats(trades)
      results[sym] = s
      allTrades = allTrades.concat(trades.map(t => ({ ...t, symbol: sym })))
      const firstTs = candles[0]?.time ? new Date(candles[0].time * 1000).toISOString().slice(0, 10) : '?'
      const lastTs  = candles[candles.length-1]?.time ? new Date(candles[candles.length-1].time * 1000).toISOString().slice(0, 10) : '?'
      console.log(`[${sym}] ${candles.length} bar (${firstTs} → ${lastTs}): trades=${s.trades} WR=${s.winRate} avgR=${s.avgR} totalR=${s.totalR} PF=${s.profitFactor} DD=${s.maxDD_R} Sharpe=${s.sharpe}`)
    } catch (e) {
      console.warn(`[${sym}] error: ${e.message}`)
    }
  }

  console.log(`\n=== AGGREGATE (all symbols) ===`)
  const agg = stats(allTrades)
  console.log(JSON.stringify(agg, null, 2))

  // Estimate annualized return
  // R units → assume risk 0.5% per trade. €1000 base. yearly ~ trades/year × avgR × 0.5%
  const yearsCovered = (1500 * 4) / (24 * 365)   // 4h × 1500 = ~7000h ≈ 0.8 yr
  const tradesPerYear = allTrades.length / yearsCovered
  const annualR = Number(agg.avgR) * tradesPerYear
  const annualPct = annualR * 0.005 * 100
  console.log(`\nEstimate (risk 0.5%/trade, € base): ~${tradesPerYear.toFixed(0)} trade/anno, ~${annualR.toFixed(1)} R/anno, ~${annualPct.toFixed(1)}% annual return`)
}

main().catch(e => { console.error(e); process.exit(1) })
