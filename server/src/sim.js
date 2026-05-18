// Simulation engine — gira nel cron handler ogni minuto.
// Stesso modello del frontend LiveSimulator.js ma persistito su D1.
import { findStrategy, STRATEGIES, atrAt } from './strategies.js'
import { getCostInR } from './costs.js'
import { loadCandles } from './data.js'
import { isBlockedByNewsSync } from './newsFilter.js'
import { isMarketOpen } from './marketHours.js'
import { isAdaptiveEnabled, maybeAdapt } from './adaptive.js'

const MAX_BARS_HOLD = {
  '1m': 30, '5m': 24, '15m': 16,
  '1h': 24, '4h': 18, '1D': 10,
}

// Phase 2 tunables — vedi changelog migration 0004 per dettagli.
const COLD_START_BARS = 3           // Fix #5.5: ridotto a 3 (era 50) per evitare shock-start. Le strategie
                                    // generano trade su nuovi segnali live, non backfill 12.5h di storia.
const COMPOUNDING_FLOOR_PCT = 0.1   // Fix #2.2: floor sul balance per sizing risk
const BLOWN_THRESHOLD_RATIO = 0.5   // Fix #2.1: auto-pause profilo se >50% account blown
const EQUITY_HEARTBEAT_SEC = 300    // Fix #2.8: heartbeat equity write (5 min)

// Murphy cap. 18: "Mai più del 2% del capitale per trade". Hard cap di sicurezza.
const RISK_PCT_HARD_CAP = 2.0       // Murphy "Trading System and Methods", capitolo 18

// Murphy trailing stop: dopo +1R muovi SL a break-even (proteggi profitto)
// Dopo +2R inizia a trailare. Implementato in checkExit con state nel pos.
const TRAIL_BE_AT_R = 1.0           // dopo +1R muovi SL a entry
const TRAIL_FOLLOW_AFTER_R = 2.0    // dopo +2R inizia trailing a 1.5 × ATR di distanza

// ── Position lifecycle ─────────────────────────────────────────────
// Murphy cap. 18 trailing stop:
//   - dopo +1R: SL muove a break-even (protezione profitto, zero rischio)
//   - dopo +2R: SL trailla a 1.5 × ATR(entry) di distanza dal max favorevole
// Stato persistito in pos.trailingActivated / pos.maxFavorable
function checkExit(pos, bar) {
  // Aggiorna max favorable e attiva trailing
  if (pos.direction === 'long') {
    if (bar.high > (pos.maxFavorable || pos.entry)) pos.maxFavorable = bar.high
    const currR = (pos.maxFavorable - pos.entry) / pos.slDist
    // Trail #1: muovi SL a BE dopo +1R (solo se non già fatto)
    if (currR >= TRAIL_BE_AT_R && pos.sl < pos.entry) {
      pos.sl = pos.entry
      pos.beActivated = true
    }
    // Trail #2: dopo +2R, trailla SL a 1.5 × ATR dal max favorable
    if (currR >= TRAIL_FOLLOW_AFTER_R && pos.atrAtEntry) {
      const trailSL = pos.maxFavorable - 1.5 * pos.atrAtEntry
      if (trailSL > pos.sl) pos.sl = trailSL
    }
    if (bar.low  <= pos.sl) return { outcome: 'sl', rawRR: pos.beActivated ? 0 : -1, exitPrice: pos.sl }
    if (bar.high >= pos.tp) return { outcome: 'tp', rawRR: pos.tpDist / pos.slDist, exitPrice: pos.tp }
  } else {
    if (bar.low < (pos.maxFavorable || pos.entry)) pos.maxFavorable = bar.low
    const currR = (pos.entry - pos.maxFavorable) / pos.slDist
    if (currR >= TRAIL_BE_AT_R && pos.sl > pos.entry) {
      pos.sl = pos.entry
      pos.beActivated = true
    }
    if (currR >= TRAIL_FOLLOW_AFTER_R && pos.atrAtEntry) {
      const trailSL = pos.maxFavorable + 1.5 * pos.atrAtEntry
      if (trailSL < pos.sl) pos.sl = trailSL
    }
    if (bar.high >= pos.sl) return { outcome: 'sl', rawRR: pos.beActivated ? 0 : -1, exitPrice: pos.sl }
    if (bar.low  <= pos.tp) return { outcome: 'tp', rawRR: pos.tpDist / pos.slDist, exitPrice: pos.tp }
  }
  return null
}

function calcTimeoutR(pos, exitPrice) {
  const pnl = pos.direction === 'long' ? exitPrice - pos.entry : pos.entry - exitPrice
  return pnl / pos.slDist
}

// ── DB helpers ─────────────────────────────────────────────────────
// Tutti i config attivi (potrebbero essere piu profili)
async function getAllConfigs(db) {
  const { results } = await db.prepare('SELECT * FROM sim_config WHERE active = 1').all()
  return results.map(row => ({
    ...row,
    pairs: JSON.parse(row.pairs),
    swing_strategies: JSON.parse(row.swing_strategies),
    scalp_strategies: JSON.parse(row.scalp_strategies),
    compounding: !!row.compounding,
    active: !!row.active,
  }))
}

async function getConfig(db, profileId = 1) {
  const row = await db.prepare('SELECT * FROM sim_config WHERE id = ?').bind(profileId).first()
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

async function getAllAccounts(db, profileId = null) {
  const sql = profileId
    ? 'SELECT * FROM sim_accounts WHERE profile_id = ?'
    : 'SELECT * FROM sim_accounts'
  const stmt = profileId ? db.prepare(sql).bind(profileId) : db.prepare(sql)
  const { results } = await stmt.all()
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
       blown = ?, blown_at = ?, last_equity_write = ?, updated_at = ?
     WHERE account_key = ?`
  ).bind(
    acc.balance, acc.peak_balance,
    acc.open_position ? JSON.stringify(acc.open_position) : null,
    acc.last_bar_time, acc.blown ? 1 : 0, acc.blown_at,
    acc.last_equity_write || 0,
    Math.floor(Date.now() / 1000),
    acc.account_key
  ).run()
}

async function insertTrade(db, accountKey, t, profileId = 1) {
  await db.prepare(
    `INSERT INTO sim_trades
       (profile_id, account_key, entry_time, exit_time, direction, entry, sl, tp, exit_price,
        outcome, raw_rr, cost_in_r, net_rr, pnl_eur, balance_after, reason, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(
    profileId, accountKey, t.entryTime, t.exitTime, t.direction,
    t.entry, t.sl, t.tp, t.exitPrice, t.outcome,
    t.rawRR, t.costInR, t.netRR, t.pnlEUR, t.balanceAfter, t.reason,
    Math.floor(Date.now() / 1000)
  ).run()
}

async function insertEquityPoint(db, accountKey, ts, balance, profileId = 1) {
  await db.prepare(
    `INSERT INTO sim_equity (profile_id, account_key, ts, balance) VALUES (?, ?, ?, ?)
     ON CONFLICT(account_key, ts) DO UPDATE SET balance = excluded.balance`
  ).bind(profileId, accountKey, ts, balance).run()
}

// ── Atomic batch builders (Fix #1.2: prevenire trade leak) ─────────
// Ritornano statements pre-bind, da passare a db.batch([...]) per persistenza atomica
// (update account + insert trades + insert equity in singola transazione).
function buildUpdateAccountStmt(db, acc) {
  return db.prepare(
    `UPDATE sim_accounts SET
       balance = ?, peak_balance = ?, open_position = ?, last_bar_time = ?,
       blown = ?, blown_at = ?, last_equity_write = ?, updated_at = ?
     WHERE account_key = ?`
  ).bind(
    acc.balance, acc.peak_balance,
    acc.open_position ? JSON.stringify(acc.open_position) : null,
    acc.last_bar_time, acc.blown ? 1 : 0, acc.blown_at,
    acc.last_equity_write || 0,            // Fix #2.8: persist heartbeat ts
    Math.floor(Date.now() / 1000),
    acc.account_key
  )
}
function buildInsertTradeStmt(db, accountKey, t, profileId = 1) {
  return db.prepare(
    `INSERT INTO sim_trades
       (profile_id, account_key, entry_time, exit_time, direction, entry, sl, tp, exit_price,
        outcome, raw_rr, cost_in_r, net_rr, pnl_eur, balance_after, reason, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(
    profileId, accountKey, t.entryTime, t.exitTime, t.direction,
    t.entry, t.sl, t.tp, t.exitPrice, t.outcome,
    t.rawRR, t.costInR, t.netRR, t.pnlEUR, t.balanceAfter, t.reason,
    Math.floor(Date.now() / 1000)
  )
}
function buildInsertEquityStmt(db, accountKey, ts, balance, profileId = 1) {
  return db.prepare(
    `INSERT INTO sim_equity (profile_id, account_key, ts, balance) VALUES (?, ?, ?, ?)
     ON CONFLICT(account_key, ts) DO UPDATE SET balance = excluded.balance`
  ).bind(profileId, accountKey, ts, balance)
}

async function logError(db, scope, symbol, message) {
  try {
    await db.prepare(
      'INSERT INTO sim_errors (ts, scope, symbol, message) VALUES (?, ?, ?, ?)'
    ).bind(Math.floor(Date.now() / 1000), scope, symbol || null, (message || '').slice(0, 500)).run()
  } catch (dbErr) {
    // Fallback: se il DB stesso fallisce, almeno stampa l'errore originale
    console.error('[logError DB FAIL]', { scope, symbol, message, dbErr: dbErr.message })
  }
}

async function incrementCycles(db, profileId = 1) {
  const now = Math.floor(Date.now() / 1000)
  await db.prepare(
    `UPDATE sim_config SET cycles = cycles + 1, last_tick_at = ?, updated_at = ? WHERE id = ?`
  ).bind(now, now, profileId).run()
}

// ── Strategy error logging — rate-limited per (strategy,symbol,tf) ──
const loggedStrategyErrors = new Set()
let lastLogReset = Date.now()
const LOG_RESET_MS = 60 * 60 * 1000  // 1h

// ── Process single account su nuove candele ────────────────────────
function processAccount(acc, candles, cfg) {
  const strategy = findStrategy(acc.strategy_id)
  if (!strategy) return { changed: false, errors: [] }

  const lastBar = candles[candles.length - 1]
  let startIdx
  if (acc.last_bar_time == null) {
    // Fix #2.7: cold-start. Era `... - 3` -> processiamo COLD_START_BARS barre
    // per non perdere segnali al boot di un nuovo account.
    startIdx = Math.max(50, candles.length - COLD_START_BARS)
  } else {
    const idx = candles.findIndex(c => c.time > acc.last_bar_time)
    if (idx < 0) return { changed: false, errors: [] }
    startIdx = idx
  }

  const maxHold = MAX_BARS_HOLD[acc.timeframe] || 30
  const newTrades = []
  const errors = []
  let changed = false

  // Rate-limit reset per ciclo (1h)
  if (Date.now() - lastLogReset > LOG_RESET_MS) {
    loggedStrategyErrors.clear()
    lastLogReset = Date.now()
  }

  for (let i = startIdx; i < candles.length; i++) {
    const bar = candles[i]
    const mktOpen = isMarketOpen(acc.symbol, bar.time).open

    // 1. Posizione aperta — FREEZE su mercato chiuso (Fix #1.3)
    if (acc.open_position) {
      if (mktOpen) {
        const exit = checkExit(acc.open_position, bar)
        if (exit) {
          const closed = closePosition(acc, exit, bar.time, cfg)
          newTrades.push(closed)
          changed = true
        } else {
          // maxHold: scorpora le barre "frozen" (mercato chiuso) dal conteggio
          const frozen = acc.open_position.frozenBars || 0
          if ((i - acc.open_position.entryBarIdx - frozen) >= maxHold) {
            const tradeR = calcTimeoutR(acc.open_position, bar.close)
            const closed = closePosition(acc, { outcome: 'timeout', rawRR: tradeR, exitPrice: bar.close }, bar.time, cfg)
            newTrades.push(closed)
            changed = true
          }
        }
      } else {
        // Mercato chiuso: freeze posizione (no checkExit, no maxHold)
        acc.open_position.frozenBars = (acc.open_position.frozenBars || 0) + 1
        changed = true  // serve per persistere frozenBars aggiornato
      }
    }

    // 2. Apertura nuovo segnale (i >= 50 per warm-up indicatori)
    if (!acc.open_position && i >= 50) {
      const sliceCandles = candles.slice(0, i + 1)
      let sig = null
      try {
        sig = strategy.fn(sliceCandles, i)
      } catch (err) {
        sig = null
        // Logging deduplicato: 1 errore per (strategy, symbol, tf) per ciclo 1h
        const key = `${strategy.id}_${acc.symbol}_${acc.timeframe}`
        if (!loggedStrategyErrors.has(key)) {
          loggedStrategyErrors.add(key)
          errors.push({
            scope: 'strategy',
            symbol: acc.symbol,
            message: `${strategy.id}: ${err.message}`,
          })
        }
      }
      if (sig?.direction) {
        // Market hours filter: skip se mercato chiuso (forex/XAU weekend)
        if (!mktOpen) {
          // Skip silente — mercato chiuso, niente trade
        } else {
          // News-event filter: skip se +/- 15min da evento alto impatto
          const newsCheck = isBlockedByNewsSync(acc.symbol, bar.time)
          if (newsCheck.blocked) {
            // Skip silente — non e' un errore, e' un filtro
          } else {
            openPosition(acc, sig, candles, i, cfg)
            changed = true
          }
        }
      }
    }
  }

  acc.last_bar_time = lastBar.time
  // Fix #2.3+#2.8: peak nell'equityPoint, null se nulla e' cambiato (dedup in runTick).
  return {
    changed, newTrades, errors,
    equityPoint: changed
      ? { ts: lastBar.time, balance: acc.balance, peak: acc.peak_balance }
      : null,
  }
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
    frozenBars: 0,  // contatore barre con mercato chiuso (Fix #1.3 weekend FREEZE)
  }
}

function closePosition(acc, exit, exitTime, cfg) {
  const pos = acc.open_position
  const rawRR = exit.rawRR
  const netRR = rawRR - pos.costInR
  // Fix #2.2: compounding floor. Se acc.balance scende sotto starting * FLOOR_PCT,
  // sizing del rischio usa il floor come base (evita risk_eur ~= 0 quasi-blown).
  const safeBalance = Math.max(acc.balance, acc.starting_balance * COMPOUNDING_FLOOR_PCT)
  const riskBase = cfg.compounding ? safeBalance : acc.starting_balance
  // Murphy 2% rule: clamp risk_pct (hard safety cap anche se config dice diverso)
  const effectiveRiskPct = Math.min(cfg.risk_pct, RISK_PCT_HARD_CAP)
  const riskEUR = riskBase * (effectiveRiskPct / 100)
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

// ── Main tick (chiamato dal cron) — gestisce tutti i profili attivi ─
export async function runTick(db, env) {
  const configs = await getAllConfigs(db)
  if (configs.length === 0) return { skipped: 'no active profiles' }

  const tdKeys = [env.TWELVEDATA_API_KEY, env.TWELVEDATA_API_KEY_2].filter(Boolean)
  const summary = { profiles: 0, processed: 0, errored: 0, accounts: 0 }

  // Carica candele UNA VOLTA per ogni (symbol, tf) condiviso tra profili
  // Fix #5.3: filtra account per cfg.pairs - cosi cambiando config (es. P1
  // da multi-pair a solo XAUUSD) gli account su pair non piu in scope vengono
  // skippati naturalmente, senza marcarli blown.
  const allAccountsByProfile = {}
  const sharedNeeds = new Map()
  for (const cfg of configs) {
    const allAccounts = await getAllAccounts(db, cfg.id)
    const inScope = new Set(cfg.pairs || [])
    const accounts = allAccounts.filter(a => inScope.size === 0 || inScope.has(a.symbol))
    allAccountsByProfile[cfg.id] = accounts
    for (const a of accounts) {
      if (a.blown) continue
      sharedNeeds.set(`${a.symbol}_${a.timeframe}`, { symbol: a.symbol, tf: a.timeframe })
    }
  }

  // Fetch candele per ogni (symbol, tf) richiesto da almeno un profilo
  const candlesCache = {}
  for (const { symbol, tf } of sharedNeeds.values()) {
    try {
      const candles = await loadCandles(db, symbol, tf, tdKeys)
      if (candles && candles.length >= 50) candlesCache[`${symbol}_${tf}`] = candles
    } catch (err) {
      await logError(db, 'data', symbol, err.message)
      summary.errored++
    }
  }

  // Process ogni profilo separatamente
  const nowSec = Math.floor(Date.now() / 1000)
  for (const cfg of configs) {
    const accounts = allAccountsByProfile[cfg.id]
    summary.profiles++
    summary.accounts += accounts.length

    // Fix #2.1b: auto-pause profile se >50% account blown.
    // Disattiviamo cfg.active e settiamo paused_reason / paused_at, poi skippiamo.
    const blownCount = accounts.filter(a => a.blown).length
    if (
      accounts.length > 0 &&
      blownCount / accounts.length > BLOWN_THRESHOLD_RATIO &&
      cfg.active
    ) {
      await db.prepare(
        `UPDATE sim_config
         SET active = 0, paused_reason = ?, paused_at = ?, updated_at = ?
         WHERE id = ?`
      ).bind('auto_paused_blown_threshold', nowSec, nowSec, cfg.id).run()
      await logError(
        db, 'auto-pause', null,
        `[p${cfg.id}] ${blownCount}/${accounts.length} accounts blown -> profile auto-paused`
      )
      continue  // skip this profile entirely
    }

    for (const acc of accounts) {
      // Fix #2.1a: blown account heartbeat — 1 equity point ogni HEARTBEAT_SEC.
      if (acc.blown) {
        try {
          const last = acc.last_equity_write || 0
          if ((nowSec - last) >= EQUITY_HEARTBEAT_SEC) {
            acc.last_equity_write = nowSec
            await db.batch([
              buildInsertEquityStmt(db, acc.account_key, nowSec, acc.balance, cfg.id),
              db.prepare(
                'UPDATE sim_accounts SET last_equity_write = ?, updated_at = ? WHERE account_key = ?'
              ).bind(nowSec, nowSec, acc.account_key),
            ])
          }
        } catch (err) {
          await logError(db, 'heartbeat', acc.symbol, `[p${cfg.id}] ${acc.account_key}: ${err.message}`)
        }
        continue
      }

      const candles = candlesCache[`${acc.symbol}_${acc.timeframe}`]
      if (!candles) continue
      try {
        const result = processAccount(acc, candles, cfg)
        // Atomic batch (Fix #1.2): update account + insert trades + insert equity
        // tutto in una transazione, evita trade leak su crash mid-write.
        const stmts = []
        if (result.changed) {
          for (const t of (result.newTrades || [])) {
            stmts.push(buildInsertTradeStmt(db, acc.account_key, t, cfg.id))
          }
        }
        // Fix #2.8: equity dedup — write solo se changed o heartbeat scaduto.
        const shouldHeartbeat = (nowSec - (acc.last_equity_write || 0)) >= EQUITY_HEARTBEAT_SEC
        if (result.equityPoint || shouldHeartbeat) {
          const ts = result.equityPoint?.ts || nowSec
          const bal = (result.equityPoint?.balance != null) ? result.equityPoint.balance : acc.balance
          stmts.push(buildInsertEquityStmt(db, acc.account_key, ts, bal, cfg.id))
          acc.last_equity_write = nowSec
        }
        if (result.changed || result.equityPoint || shouldHeartbeat) {
          stmts.unshift(buildUpdateAccountStmt(db, acc))
        }
        if (stmts.length) await db.batch(stmts)
        // Strategy errors raccolti (Fix #1.6) — log fuori dalla transazione
        for (const e of (result.errors || [])) {
          await logError(db, e.scope, e.symbol, `[p${cfg.id}] ${acc.account_key}: ${e.message}`)
        }
        // Fix #4.2: Adaptive SL/TP — recompute ogni 20 trade chiusi (env-gated)
        if (isAdaptiveEnabled() && result.newTrades?.length > 0) {
          await maybeAdapt(db, acc)
        }
        summary.processed++
      } catch (err) {
        await logError(db, 'strategy', acc.symbol, `[p${cfg.id}] ${acc.account_key}: ${err.message}`)
        summary.errored++
      }
    }
    await incrementCycles(db, cfg.id)
  }

  return summary
}

// ── Init: crea account quando si avvia simulazione ─────────────────
export async function initAccounts(db, cfg, profileId = 1) {
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
  // account_key include profile prefix per evitare collisioni tra profili diversi
  const keyPrefix = profileId === 1 ? '' : `p${profileId}_`
  const now = Math.floor(Date.now() / 1000)
  for (const { strategy, pair, tf } of allCombos) {
    const key = `${keyPrefix}${strategy.id}_${pair}_${tf}`
    await db.prepare(
      `INSERT OR IGNORE INTO sim_accounts
        (account_key, profile_id, strategy_id, strategy_name, category, symbol, timeframe,
         sl_mul, tp_mul, starting_balance, balance, peak_balance,
         open_position, last_bar_time, blown, blown_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, 0, NULL, ?, ?)`
    ).bind(
      key, profileId, strategy.id, strategy.name, strategy.category, pair, tf,
      strategy.slMul, strategy.tpMul, cfg.starting_balance, cfg.starting_balance,
      cfg.starting_balance, now, now
    ).run()
  }
  return allCombos.length
}
