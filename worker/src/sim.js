// Simulation engine — gira nel cron handler ogni minuto.
// Stesso modello del frontend LiveSimulator.js ma persistito su D1.
import { findStrategy, STRATEGIES, atrAt } from './strategies.js'
import { getCostInR } from './costs.js'
import { loadCandles } from './data.js'

const MAX_BARS_HOLD = {
  '1m': 30, '5m': 24, '15m': 16,
  '1h': 24, '4h': 18, '1D': 10,
}

// ── Position lifecycle ─────────────────────────────────────────────
function checkExit(pos, bar) {
  if (pos.direction === 'long') {
    if (bar.low  <= pos.sl) return { outcome: 'sl', rawRR: -1, exitPrice: pos.sl }
    if (bar.high >= pos.tp) return { outcome: 'tp', rawRR: pos.tpDist / pos.slDist, exitPrice: pos.tp }
  } else {
    if (bar.high >= pos.sl) return { outcome: 'sl', rawRR: -1, exitPrice: pos.sl }
    if (bar.low  <= pos.tp) return { outcome: 'tp', rawRR: pos.tpDist / pos.slDist, exitPrice: pos.tp }
  }
  return null
}

function calcTimeoutR(pos, exitPrice) {
  const pnl = pos.direction === 'long' ? exitPrice - pos.entry : pos.entry - exitPrice
  return pnl / pos.slDist
}

// ── DB helpers ─────────────────────────────────────────────────────
async function getConfig(db) {
  const row = await db.prepare('SELECT * FROM sim_config WHERE id = 1').first()
  if (!row) return null
  return {
    ...row,
    pairs: JSON.parse(row.pairs),
    swing_strategies: JSON.parse(row.swing_strategies),
    scalp_strategies: JSON.parse(row.scalp_strategies),
    compounding: !!row.compounding,
    active: !!row.active,
  }
}

async function getAllAccounts(db) {
  const { results } = await db.prepare('SELECT * FROM sim_accounts').all()
  return results.map(r => ({
    ...r,
    open_position: r.open_position ? JSON.parse(r.open_position) : null,
    blown: !!r.blown,
  }))
}

async function updateAccount(db, acc) {
  await db.prepare(
    `UPDATE sim_accounts SET
       balance = ?, peak_balance = ?, open_position = ?, last_bar_time = ?,
       blown = ?, blown_at = ?, updated_at = ?
     WHERE account_key = ?`
  ).bind(
    acc.balance, acc.peak_balance,
    acc.open_position ? JSON.stringify(acc.open_position) : null,
    acc.last_bar_time, acc.blown ? 1 : 0, acc.blown_at,
    Math.floor(Date.now() / 1000),
    acc.account_key
  ).run()
}

async function insertTrade(db, accountKey, t) {
  await db.prepare(
    `INSERT INTO sim_trades
       (account_key, entry_time, exit_time, direction, entry, sl, tp, exit_price,
        outcome, raw_rr, cost_in_r, net_rr, pnl_eur, balance_after, reason)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(
    accountKey, t.entryTime, t.exitTime, t.direction,
    t.entry, t.sl, t.tp, t.exitPrice, t.outcome,
    t.rawRR, t.costInR, t.netRR, t.pnlEUR, t.balanceAfter, t.reason
  ).run()
}

async function insertEquityPoint(db, accountKey, ts, balance) {
  await db.prepare(
    `INSERT INTO sim_equity (account_key, ts, balance) VALUES (?, ?, ?)
     ON CONFLICT(account_key, ts) DO UPDATE SET balance = excluded.balance`
  ).bind(accountKey, ts, balance).run()
}

async function logError(db, scope, symbol, message) {
  try {
    await db.prepare(
      'INSERT INTO sim_errors (scope, symbol, message) VALUES (?, ?, ?)'
    ).bind(scope, symbol || null, (message || '').slice(0, 500)).run()
  } catch {}
}

async function incrementCycles(db) {
  await db.prepare(
    `UPDATE sim_config SET cycles = cycles + 1, last_tick_at = ?, updated_at = ? WHERE id = 1`
  ).bind(Math.floor(Date.now() / 1000), Math.floor(Date.now() / 1000)).run()
}

// ── Process single account su nuove candele ────────────────────────
function processAccount(acc, candles, cfg) {
  const strategy = findStrategy(acc.strategy_id)
  if (!strategy) return { changed: false }

  const lastBar = candles[candles.length - 1]
  let startIdx
  if (acc.last_bar_time == null) {
    startIdx = Math.max(50, candles.length - 3)
  } else {
    const idx = candles.findIndex(c => c.time > acc.last_bar_time)
    if (idx < 0) return { changed: false }
    startIdx = idx
  }

  const maxHold = MAX_BARS_HOLD[acc.timeframe] || 30
  const newTrades = []
  let changed = false

  for (let i = startIdx; i < candles.length; i++) {
    const bar = candles[i]

    // 1. Check posizione aperta
    if (acc.open_position) {
      const exit = checkExit(acc.open_position, bar)
      if (exit) {
        const closed = closePosition(acc, exit, bar.time, cfg)
        newTrades.push(closed)
        changed = true
      } else if (i - acc.open_position.entryBarIdx >= maxHold) {
        const tradeR = calcTimeoutR(acc.open_position, bar.close)
        const closed = closePosition(acc, { outcome: 'timeout', rawRR: tradeR, exitPrice: bar.close }, bar.time, cfg)
        newTrades.push(closed)
        changed = true
      }
    }

    // 2. Apertura nuovo segnale
    if (!acc.open_position && i >= 50) {
      const sliceCandles = candles.slice(0, i + 1)
      let sig = null
      try { sig = strategy.fn(sliceCandles, i) } catch { sig = null }
      if (sig?.direction) {
        openPosition(acc, sig, candles, i, cfg)
        changed = true
      }
    }
  }

  acc.last_bar_time = lastBar.time
  return { changed, newTrades, equityPoint: { ts: lastBar.time, balance: acc.balance } }
}

function openPosition(acc, sig, candles, i, cfg) {
  const a = atrAt(candles, 14, i)
  if (!a || a === 0) return
  const entry = candles[i].close
  const slDist = a * acc.sl_mul
  const tpDist = a * acc.tp_mul
  const sl = sig.direction === 'long' ? entry - slDist : entry + slDist
  const tp = sig.direction === 'long' ? entry + tpDist : entry - tpDist
  const costInR = getCostInR(acc.symbol, a, slDist, cfg.broker_id)
  acc.open_position = {
    direction: sig.direction, reason: sig.reason,
    entry, sl, tp, slDist, tpDist, costInR,
    atrAtEntry: a,
    entryTime: candles[i].time, entryBarIdx: i,
  }
}

function closePosition(acc, exit, exitTime, cfg) {
  const pos = acc.open_position
  const rawRR = exit.rawRR
  const netRR = rawRR - pos.costInR
  const riskBase = cfg.compounding ? acc.balance : acc.starting_balance
  const riskEUR = riskBase * (cfg.risk_pct / 100)
  const pnlEUR = netRR * riskEUR
  acc.balance += pnlEUR
  if (acc.balance > acc.peak_balance) acc.peak_balance = acc.balance
  if (acc.balance < acc.starting_balance * 0.5) {
    acc.blown = true
    acc.blown_at = exitTime
  }
  const trade = {
    entryTime: pos.entryTime, exitTime,
    direction: pos.direction,
    entry: pos.entry, sl: pos.sl, tp: pos.tp, exitPrice: exit.exitPrice,
    outcome: exit.outcome,
    rawRR, costInR: pos.costInR, netRR,
    pnlEUR, balanceAfter: acc.balance, reason: pos.reason,
  }
  acc.open_position = null
  return trade
}

// ── Main tick (chiamato dal cron) ──────────────────────────────────
export async function runTick(db, env) {
  const cfg = await getConfig(db)
  if (!cfg || !cfg.active) return { skipped: 'not active' }

  const accounts = await getAllAccounts(db)
  const tdKeys = [env.TWELVEDATA_API_KEY, env.TWELVEDATA_API_KEY_2].filter(Boolean)

  // Group needed (symbol, tf)
  const needs = new Map()
  for (const a of accounts) {
    if (a.blown) continue
    needs.set(`${a.symbol}_${a.timeframe}`, { symbol: a.symbol, tf: a.timeframe })
  }

  let processed = 0, errored = 0

  for (const { symbol, tf } of needs.values()) {
    let candles
    try {
      candles = await loadCandles(db, symbol, tf, tdKeys)
    } catch (err) {
      await logError(db, 'data', symbol, err.message)
      errored++
      continue
    }
    if (!candles || candles.length < 50) continue

    for (const acc of accounts) {
      if (acc.symbol !== symbol || acc.timeframe !== tf) continue
      if (acc.blown) continue
      try {
        const result = processAccount(acc, candles, cfg)
        if (result.changed) {
          await updateAccount(db, acc)
          if (result.newTrades) {
            for (const t of result.newTrades) {
              await insertTrade(db, acc.account_key, t)
            }
          }
        }
        if (result.equityPoint) {
          await insertEquityPoint(db, acc.account_key, result.equityPoint.ts, result.equityPoint.balance)
        }
        processed++
      } catch (err) {
        await logError(db, 'strategy', acc.symbol, `${acc.account_key}: ${err.message}`)
        errored++
      }
    }
  }

  await incrementCycles(db)
  return { processed, errored, accounts: accounts.length }
}

// ── Init: crea account quando si avvia simulazione ─────────────────
export async function initAccounts(db, cfg) {
  const allCombos = []
  const swingIds = cfg.swing_strategies || []
  const scalpIds = cfg.scalp_strategies || []
  for (const id of swingIds) {
    const s = findStrategy(id)
    if (!s || s.category !== 'swing') continue
    for (const pair of cfg.pairs) {
      allCombos.push({ strategy: s, pair, tf: cfg.swing_tf })
    }
  }
  for (const id of scalpIds) {
    const s = findStrategy(id)
    if (!s || s.category !== 'scalp') continue
    for (const pair of cfg.pairs) {
      // Compatibility check (semplificato): scalping su tutti
      allCombos.push({ strategy: s, pair, tf: cfg.scalp_tf })
    }
  }

  // Insert ignore (preserva account esistenti)
  for (const { strategy, pair, tf } of allCombos) {
    const key = `${strategy.id}_${pair}_${tf}`
    await db.prepare(
      `INSERT OR IGNORE INTO sim_accounts
        (account_key, strategy_id, strategy_name, category, symbol, timeframe,
         sl_mul, tp_mul, starting_balance, balance, peak_balance,
         open_position, last_bar_time, blown)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, 0)`
    ).bind(
      key, strategy.id, strategy.name, strategy.category, pair, tf,
      strategy.slMul, strategy.tpMul, cfg.starting_balance, cfg.starting_balance,
      cfg.starting_balance
    ).run()
  }
  return allCombos.length
}
