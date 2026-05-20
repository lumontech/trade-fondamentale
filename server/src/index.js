// Impact Trading Server — Node.js + Hono + node-cron + better-sqlite3
// Sostituisce il Cloudflare Worker. Stessa API REST e stesso engine.
import 'dotenv/config'
import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { serve } from '@hono/node-server'
import cron from 'node-cron'
import { d1Adapter, initSchema } from './db.js'
import { runTick, initAccounts } from './sim.js'
import { STRATEGIES } from './strategies.js'
import { refreshNewsCache, getNewsCacheStats } from './newsFilter.js'
import { getTdQuota } from './data.js'
import {
  login, logout, authMiddleware,
  cleanupExpiredSessions, getTokenFromRequest,
  COOKIE_NAME, SESSION_TTL_SEC,
} from './auth.js'
import { makeCtraderAuthRoutes, loadTokens, listAccounts, getValidAccessToken } from './ctraderAuth.js'
import {
  initCtraderClient, isCtraderReady, ctraderFetchCandles, ctraderListSymbols,
} from './ctraderDataSource.js'
import { yahooFetchCandles, yahooListSymbols } from './yahooDataSource.js'
import { ctraderFixInit, ctraderFixStop, ctraderFixStatus, ctraderFixGetCandles, ctraderFixGetCurrentQuote } from './ctraderFixClient.js'
import { registerMacroRoutes } from './macroProxy.js'
import {
  listUserApiKeys, setUserApiKey, deleteUserApiKey, getCryptoStatus,
} from './userApiKeys.js'
import { registerTradeLogRoutes } from './userTradeLog.js'

const PORT = Number(process.env.PORT) || 3000
const IS_PRODUCTION = process.env.NODE_ENV === 'production'

// Fix #3.2: CORS strict. In production: niente fallback al localhost — origin
// deve venire SOLO da ALLOWED_ORIGINS. In dev: fallback a localhost:5173.
// Filtra entry vuote per evitare "" che matcha origin null.
const defaultAllowed = IS_PRODUCTION ? '' : 'http://localhost:5173'
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || defaultAllowed)
  .split(',').map(s => s.trim()).filter(Boolean)
if (ALLOWED_ORIGINS.length === 0) {
  console.warn('[CORS] ALLOWED_ORIGINS not set — cross-origin requests will be refused')
}

// Bootstrap schema
initSchema()

// Env-like object compatibile con il codice worker (env.DB, env.TWELVEDATA_API_KEY, ...)
const env = {
  DB: d1Adapter(),
  TWELVEDATA_API_KEY:   process.env.TWELVEDATA_API_KEY || '',
  TWELVEDATA_API_KEY_2: process.env.TWELVEDATA_API_KEY_2 || '',
  DEFAULT_BROKER_ID:        process.env.DEFAULT_BROKER_ID || 'fpmarkets_raw',
  DEFAULT_STARTING_BALANCE: process.env.DEFAULT_STARTING_BALANCE || '1000',
  DEFAULT_RISK_PCT:         process.env.DEFAULT_RISK_PCT || '1',
  ALLOWED_ORIGINS:          ALLOWED_ORIGINS.join(','),
  // Fix #5.14: cTrader Open API credentials (data source sostitutivo TwelveData)
  CTRADER_CLIENT_ID:     process.env.CTRADER_CLIENT_ID     || '',
  CTRADER_CLIENT_SECRET: process.env.CTRADER_CLIENT_SECRET || '',
  CTRADER_REDIRECT_URI:  process.env.CTRADER_REDIRECT_URI  || '',
  CTRADER_ENV:           process.env.CTRADER_ENV           || 'demo',
}
const ctraderAuthRoutes = makeCtraderAuthRoutes(env)

const app = new Hono()

app.use('*', cors({
  // credentials:true esige che origin NON sia '*'. Se non in whitelist → reject.
  origin: (origin) => ALLOWED_ORIGINS.includes(origin) ? origin : null,
  credentials: true,                              // necessario per cookie HttpOnly
  allowMethods: ['GET', 'POST', 'OPTIONS'],
  allowHeaders: ['Content-Type', 'Authorization'],
  maxAge: 86400,
}))

// ── Auth: session-based (cookie HttpOnly) ──────────────────────────────
// Public paths: solo /api/health (uptime probe) e /api/auth/login (per loggarsi).
// Tutto il resto richiede sessione valida (cookie itp_session).
// Il middleware setta c.set('user', ...) per gli handler downstream.
// Fix #5.14: /api/ctrader/auth/start e /callback sono OAuth redirect — niente cookie session.
app.use('/api/*', authMiddleware(env.DB, [
  '/api/health',
  '/api/auth/login',
  '/api/ctrader/auth/start',
  '/api/ctrader/auth/callback',
  // Yahoo proxy: public — fornisce solo candele storiche pubbliche di simboli forex/XAU/oil
  // (zero PII, zero impatto su stato/credenziali). Necessario per fallback frontend quando
  // TwelveData quota esaurita, anche per utenti non loggati che stanno valutando l'app.
  '/api/yahoo/candles',
  '/api/yahoo/symbols',
  // Macro proxy: dati pubblici aggregati (ForexFactory calendar, FRED yields, F&G Index).
  // Cache 15-30 min, zero PII, sostituisce corsproxy.io che dava 403.
  // Prefix match copre /api/macro/ff-calendar, /api/macro/fng, /api/macro/fred/:series
  '/api/macro',
]))

// ── Rate limit (Fix #3.3) ──────────────────────────────────────────────
// Sliding-window in-memory per IP. No nuove dependency: Map + setInterval.
// Default: 10 req/min per /api/tick, sufficiente per debug manuale + cron.
// /api/auth/login ha gia' un proprio lockout (5 tentativi/15min in auth.js),
// ma applichiamo rate-limit anche a livello IP come secondo livello.
const _rateLimitBuckets = new Map()
function rateLimit(c, max = 10, windowMs = 60_000) {
  const ip = c.req.header('x-forwarded-for') || c.req.header('cf-connecting-ip') || 'unknown'
  const now = Date.now()
  let b = _rateLimitBuckets.get(ip)
  if (!b || now > b.reset) {
    b = { count: 0, reset: now + windowMs }
    _rateLimitBuckets.set(ip, b)
  }
  b.count++
  return b.count <= max
}
// Cleanup buckets ogni 5 min (no leak su IP rotanti).
setInterval(() => {
  const now = Date.now()
  for (const [ip, b] of _rateLimitBuckets.entries()) {
    if (now > b.reset) _rateLimitBuckets.delete(ip)
  }
}, 5 * 60 * 1000)

// ── Helpers ────────────────────────────────────────────────────────

// Lista tutti i profili
async function listProfiles() {
  const { results } = await env.DB.prepare(
    'SELECT id, label, active, started_at, broker_id, starting_balance, cycles, last_tick_at FROM sim_config ORDER BY id ASC'
  ).all()
  return results.map(r => ({ ...r, active: !!r.active }))
}

// Fix #5.1 metrics aggregation: SELECT clause + LEFT JOIN con sim_trades
// che espone total_trades, wins, losses, win_rate, profit_factor,
// total_pnl_eur, avg_rr. Senza questo il frontend mostra "Trade=0 / WR=- / PF=-".
const ACCOUNT_METRICS_SQL = `
  a.*,
  COALESCE(t.total_trades, 0) AS total_trades,
  COALESCE(t.total_trades, 0) AS totalTrades,
  COALESCE(t.wins, 0)         AS wins,
  COALESCE(t.losses, 0)       AS losses,
  CASE WHEN t.total_trades > 0 THEN ROUND(100.0 * t.wins / t.total_trades, 2) ELSE NULL END AS win_rate,
  CASE WHEN t.total_trades > 0 THEN ROUND(1.0 * t.wins / t.total_trades, 4) ELSE NULL END AS winRate,
  CASE WHEN t.gross_loss_r > 0 THEN ROUND(t.gross_profit_r / t.gross_loss_r, 2) ELSE NULL END AS profit_factor,
  CASE WHEN t.gross_loss_r > 0 THEN ROUND(t.gross_profit_r / t.gross_loss_r, 2) ELSE NULL END AS profitFactor,
  COALESCE(ROUND(t.total_pnl_eur, 2), 0) AS total_pnl_eur,
  COALESCE(ROUND(t.total_pnl_eur, 2), 0) AS totalPnlEur,
  CASE WHEN t.total_trades > 0 THEN ROUND(t.avg_rr, 3) ELSE NULL END AS avg_rr,
  CASE WHEN t.total_trades > 0 THEN ROUND(t.avg_rr, 3) ELSE NULL END AS avgRR
FROM sim_accounts a
LEFT JOIN (
  SELECT
    account_key,
    COUNT(*) AS total_trades,
    SUM(CASE WHEN raw_rr > 0  THEN 1 ELSE 0 END) AS wins,
    SUM(CASE WHEN raw_rr <= 0 THEN 1 ELSE 0 END) AS losses,
    SUM(CASE WHEN net_rr > 0  THEN net_rr  ELSE 0 END) AS gross_profit_r,
    SUM(CASE WHEN net_rr < 0  THEN -net_rr ELSE 0 END) AS gross_loss_r,
    SUM(pnl_eur) AS total_pnl_eur,
    AVG(raw_rr)  AS avg_rr
  FROM sim_trades
  GROUP BY account_key
) t ON t.account_key = a.account_key
`

async function getState(profileId = 1) {
  const cfg = await env.DB.prepare('SELECT * FROM sim_config WHERE id = ?').bind(profileId).first()
  const { results: accounts } = await env.DB.prepare(
    `SELECT ${ACCOUNT_METRICS_SQL} WHERE a.profile_id = ?`
  ).bind(profileId).all()
  // Fix #5.2: il frontend (summarizeAccount in LiveSimulator.js) ricalcola le metriche
  // partendo da acc.trades, acc.openPosition, acc.startingBalance, acc.peakBalance.
  // Quindi attacchiamo i trade minimi e gli alias camelCase.
  const { results: allTrades } = await env.DB.prepare(
    `SELECT account_key, outcome, raw_rr AS rawRR, net_rr AS netRR,
            pnl_eur AS pnlEUR, entry_time AS entryTime, exit_time AS exitTime,
            direction, entry, sl, tp
     FROM sim_trades WHERE profile_id = ? ORDER BY entry_time ASC`
  ).bind(profileId).all()
  const tradesByAcc = {}
  for (const t of allTrades) {
    if (!tradesByAcc[t.account_key]) tradesByAcc[t.account_key] = []
    tradesByAcc[t.account_key].push({
      outcome: t.outcome,
      rawRR: t.rawRR, netRR: t.netRR, pnlEUR: t.pnlEUR,
      entryTime: t.entryTime, exitTime: t.exitTime,
      direction: t.direction, entry: t.entry, sl: t.sl, tp: t.tp,
    })
  }
  // Fix #5.6: lastPrice da candle_cache per ogni (symbol,tf) — il frontend lo usa
  // come fallback quando lo store browser non ha il pair (es. Hyperliquid USDC pair).
  const { results: cacheRows } = await env.DB.prepare(
    `SELECT symbol, timeframe, candles_json FROM candle_cache`
  ).all()
  const lastPriceByKey = {}
  for (const row of cacheRows) {
    try {
      const c = JSON.parse(row.candles_json)
      const last = c?.[c.length - 1]
      if (last?.close != null) {
        lastPriceByKey[`${row.symbol}_${row.timeframe}`] = last.close
        // fallback per symbol senza tf-specific match
        if (!lastPriceByKey[row.symbol]) lastPriceByKey[row.symbol] = last.close
      }
    } catch {}
  }
  return {
    config: cfg ? {
      ...cfg,
      pairs: JSON.parse(cfg.pairs || '[]'),
      swing_strategies: JSON.parse(cfg.swing_strategies || '[]'),
      scalp_strategies: JSON.parse(cfg.scalp_strategies || '[]'),
      compounding: !!cfg.compounding,
      active: !!cfg.active,
    } : null,
    accounts: accounts.map(a => {
      const op = a.open_position ? JSON.parse(a.open_position) : null
      const lastPrice = lastPriceByKey[`${a.symbol}_${a.timeframe}`] || lastPriceByKey[a.symbol] || null
      return {
        ...a,
        open_position: op,
        openPosition: op,                                  // camelCase alias
        startingBalance: a.starting_balance,               // camelCase alias
        peakBalance: a.peak_balance,                       // camelCase alias
        strategyId: a.strategy_id,
        strategyName: a.strategy_name,
        slMul: a.sl_mul, tpMul: a.tp_mul,
        accountKey: a.account_key,
        blown: !!a.blown,
        trades: tradesByAcc[a.account_key] || [],
        lastPrice,                                         // Fix #5.6: fallback per Floating P&L
      }
    }),
  }
}

async function getAccountDetail(key) {
  // Fix #5.1 metrics aggregation: stesse metriche di getState() sul singolo account.
  const acc = await env.DB.prepare(
    `SELECT ${ACCOUNT_METRICS_SQL} WHERE a.account_key = ?`
  ).bind(key).first()
  if (!acc) return null
  const { results: trades } = await env.DB.prepare(
    'SELECT * FROM sim_trades WHERE account_key = ? ORDER BY entry_time DESC LIMIT 100'
  ).bind(key).all()
  const { results: equity } = await env.DB.prepare(
    'SELECT ts, balance FROM sim_equity WHERE account_key = ? ORDER BY ts ASC LIMIT 1000'
  ).bind(key).all()
  const op = acc.open_position ? JSON.parse(acc.open_position) : null
  return {
    account: {
      ...acc,
      open_position: op,
      openPosition: op,
      startingBalance: acc.starting_balance,
      peakBalance: acc.peak_balance,
      strategyId: acc.strategy_id,
      strategyName: acc.strategy_name,
      slMul: acc.sl_mul, tpMul: acc.tp_mul,
      accountKey: acc.account_key,
      blown: !!acc.blown,
    },
    trades, equity,
  }
}

async function startSim(body, profileId = 1) {
  const cfg = {
    label: body.label || (profileId === 1 ? 'Main FPMarkets EU' : `Profile ${profileId}`),
    pairs: body.pairs || ['XAUUSD', 'BTCUSD', 'EURUSD', 'GBPUSD', 'USDJPY', 'GBPJPY', 'EURGBP', 'EURJPY'],
    // Fix #4.1: default exclude strategie disabilitate (enabled === false).
    swing_strategies: body.swing_strategies || STRATEGIES.filter(s => s.category === 'swing' && s.enabled !== false).map(s => s.id),
    scalp_strategies: body.scalp_strategies || STRATEGIES.filter(s => s.category === 'scalp' && s.enabled !== false).map(s => s.id),
    swing_tf: body.swing_tf || '4h',
    scalp_tf: body.scalp_tf || '15m',
    starting_balance: body.starting_balance || Number(env.DEFAULT_STARTING_BALANCE) || 1000,
    risk_pct: body.risk_pct || Number(env.DEFAULT_RISK_PCT) || 1,
    compounding: body.compounding !== false,
    broker_id: body.broker_id || env.DEFAULT_BROKER_ID,
  }
  const now = Math.floor(Date.now() / 1000)
  await env.DB.prepare(
    `INSERT INTO sim_config
       (id, label, active, started_at, stopped_at, pairs, swing_strategies, scalp_strategies,
        swing_tf, scalp_tf, starting_balance, risk_pct, compounding, broker_id, cycles, updated_at)
     VALUES (?, ?, 1, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)
     ON CONFLICT(id) DO UPDATE SET
       label = excluded.label,
       active = 1, stopped_at = NULL,
       pairs = excluded.pairs,
       swing_strategies = excluded.swing_strategies,
       scalp_strategies = excluded.scalp_strategies,
       swing_tf = excluded.swing_tf,
       scalp_tf = excluded.scalp_tf,
       starting_balance = excluded.starting_balance,
       risk_pct = excluded.risk_pct,
       compounding = excluded.compounding,
       broker_id = excluded.broker_id,
       updated_at = excluded.updated_at`
  ).bind(
    profileId, cfg.label, now,
    JSON.stringify(cfg.pairs),
    JSON.stringify(cfg.swing_strategies),
    JSON.stringify(cfg.scalp_strategies),
    cfg.swing_tf, cfg.scalp_tf,
    cfg.starting_balance, cfg.risk_pct,
    cfg.compounding ? 1 : 0,
    cfg.broker_id, now
  ).run()
  const created = await initAccounts(env.DB, cfg, profileId)
  return { ok: true, profile_id: profileId, accounts_initialized: created }
}

async function stopSim(profileId = 1) {
  const now = Math.floor(Date.now() / 1000)
  await env.DB.prepare(
    'UPDATE sim_config SET active = 0, stopped_at = ?, updated_at = ? WHERE id = ?'
  ).bind(now, now, profileId).run()
  return { ok: true, profile_id: profileId }
}

async function resumeSim(profileId = 1) {
  const now = Math.floor(Date.now() / 1000)
  await env.DB.prepare(
    'UPDATE sim_config SET active = 1, stopped_at = NULL, updated_at = ? WHERE id = ?'
  ).bind(now, profileId).run()
  return { ok: true, profile_id: profileId }
}

async function resetSim(profileId = null) {
  if (profileId) {
    // Reset solo questo profilo
    await env.DB.batch([
      env.DB.prepare('DELETE FROM sim_trades WHERE profile_id = ?').bind(profileId),
      env.DB.prepare('DELETE FROM sim_equity WHERE profile_id = ?').bind(profileId),
      env.DB.prepare('DELETE FROM sim_accounts WHERE profile_id = ?').bind(profileId),
      env.DB.prepare('DELETE FROM sim_config WHERE id = ?').bind(profileId),
    ])
  } else {
    // Reset globale
    await env.DB.batch([
      env.DB.prepare('DELETE FROM sim_trades'),
      env.DB.prepare('DELETE FROM sim_equity'),
      env.DB.prepare('DELETE FROM sim_accounts'),
      env.DB.prepare('DELETE FROM sim_errors'),
      env.DB.prepare('DELETE FROM candle_cache'),
      env.DB.prepare('DELETE FROM sim_config'),
    ])
  }
  return { ok: true }
}

// ── Routes ─────────────────────────────────────────────────────────
app.get('/api/health', (c) => c.json({ ok: true, ts: Date.now() }))

// ── Auth routes ────────────────────────────────────────────────────
// POST /api/auth/login  → setta cookie itp_session HttpOnly
// POST /api/auth/logout → distrugge sessione + clear cookie
// GET  /api/auth/me     → ritorna user corrente (richiede sessione)
app.post('/api/auth/login', async (c) => {
  let body
  try { body = await c.req.json() } catch { body = {} }
  const { username, password } = body || {}
  if (!username || !password) return c.json({ error: 'missing_credentials' }, 400)

  const ip = c.req.header('x-forwarded-for') || c.req.header('cf-connecting-ip') || 'unknown'
  const ua = c.req.header('user-agent') || ''
  const result = await login(env.DB, String(username), String(password), ip, ua)
  if (!result.ok) {
    const status = result.error === 'too_many_attempts' ? 429 : 401
    return c.json(result, status)
  }
  // Cookie HttpOnly: nessun accesso da JS → mitiga XSS exfil. SameSite=Lax
  // permette navigazione da link esterni mantenendo CSRF protection per POST.
  // Secure solo in production (development su http://localhost).
  const cookieParts = [
    `${COOKIE_NAME}=${result.token}`,
    'HttpOnly',
    'SameSite=Lax',
    'Path=/',
    `Max-Age=${SESSION_TTL_SEC}`,
  ]
  if (IS_PRODUCTION) cookieParts.push('Secure')
  c.header('Set-Cookie', cookieParts.join('; '))
  return c.json({ ok: true, user: result.user, expiresIn: result.expiresIn })
})

app.post('/api/auth/logout', async (c) => {
  const token = getTokenFromRequest(c)
  await logout(env.DB, token)
  const clearParts = [
    `${COOKIE_NAME}=`,
    'HttpOnly',
    'SameSite=Lax',
    'Path=/',
    'Max-Age=0',
  ]
  if (IS_PRODUCTION) clearParts.push('Secure')
  c.header('Set-Cookie', clearParts.join('; '))
  return c.json({ ok: true })
})

app.get('/api/auth/me', async (c) => {
  const user = c.get('user')   // settato dal authMiddleware
  return c.json({ user: { id: user.user_id, username: user.username, role: user.role } })
})

// ── User API keys (per-user, encrypted at rest) ────────────────────
// Le chiavi sono legate all'utente, NON al device. Login da un altro PC
// → fetch automatico delle proprie key dal server.
app.get('/api/user/api-keys/status', (c) => c.json(getCryptoStatus()))

app.get('/api/user/api-keys', async (c) => {
  const user = c.get('user')
  if (!user) return c.json({ error: 'unauthorized' }, 401)
  try {
    const keys = await listUserApiKeys(env.DB, user.user_id)
    return c.json({ keys })
  } catch (err) {
    console.error('[user-api-keys] list:', err.message)
    return c.json({ error: err.message }, 500)
  }
})

app.put('/api/user/api-keys', async (c) => {
  const user = c.get('user')
  if (!user) return c.json({ error: 'unauthorized' }, 401)
  try {
    const body = await c.req.json()
    if (!body?.service || typeof body.service !== 'string') {
      return c.json({ error: 'service required' }, 400)
    }
    if (typeof body.key !== 'string') {
      return c.json({ error: 'key must be string' }, 400)
    }
    const result = await setUserApiKey(env.DB, user.user_id, body.service, body.key)
    return c.json(result)
  } catch (err) {
    console.error('[user-api-keys] set:', err.message)
    return c.json({ error: err.message }, 400)
  }
})

app.delete('/api/user/api-keys/:service', async (c) => {
  const user = c.get('user')
  if (!user) return c.json({ error: 'unauthorized' }, 401)
  const service = c.req.param('service')
  try {
    const result = await deleteUserApiKey(env.DB, user.user_id, service)
    return c.json(result)
  } catch (err) {
    return c.json({ error: err.message }, 500)
  }
})

// Fix #5.14: cTrader Open API OAuth flow
//   GET  /api/ctrader/auth/start    → redirect a openapi.ctrader.com auth page
//   GET  /api/ctrader/auth/callback → callback redirect, scambia code → token, salva DB
//   GET  /api/ctrader/auth/status   → mostra stato auth + scadenze
//   GET  /api/ctrader/auth/accounts → lista account associati al token
app.get('/api/ctrader/auth/start', ctraderAuthRoutes.start)
app.get('/api/ctrader/auth/callback', ctraderAuthRoutes.callback)
app.get('/api/ctrader/auth/status', ctraderAuthRoutes.status)
app.get('/api/ctrader/auth/accounts', ctraderAuthRoutes.accounts)

// Seleziona un account fra quelli disponibili dell'utente (chiamato dopo OAuth).
// Body: { account_id, account_label, is_live }
app.post('/api/ctrader/auth/select-account', async (c) => {
  const body = await c.req.json().catch(() => ({}))
  const { account_id, account_label, is_live } = body
  if (!account_id) return c.json({ error: 'account_id required' }, 400)
  const now = Math.floor(Date.now() / 1000)
  await env.DB.prepare(
    'UPDATE ctrader_tokens SET account_id = ?, account_label = ?, is_live = ?, updated_at = ? WHERE id = 1'
  ).bind(account_id, account_label || null, is_live ? 1 : 0, now).run()
  // Re-init client con nuovo account
  await initCtraderClient(env)
  return c.json({ ok: true, ready: isCtraderReady() })
})

// Candele live da cTrader Open API (FPMarkets data)
app.get('/api/ctrader/candles', async (c) => {
  if (!isCtraderReady()) {
    await initCtraderClient(env)
    if (!isCtraderReady()) return c.json({ error: 'ctrader_not_ready', hint: 'Run /api/ctrader/auth/start first' }, 503)
  }
  const symbol = c.req.query('symbol')
  const tf     = c.req.query('tf') || '1h'
  const count  = Number(c.req.query('count') || 200)
  if (!symbol) return c.json({ error: 'symbol required' }, 400)
  try {
    const candles = await ctraderFetchCandles(symbol, tf, count)
    return c.json({ symbol, tf, candles })
  } catch (err) {
    return c.json({ error: err.message }, 500)
  }
})

// Lista simboli disponibili sul broker dell'utente (es. FPMarkets ha ~80 simboli)
app.get('/api/ctrader/symbols', async (c) => {
  if (!isCtraderReady()) {
    await initCtraderClient(env)
    if (!isCtraderReady()) return c.json({ error: 'ctrader_not_ready' }, 503)
  }
  return c.json({ symbols: ctraderListSymbols() })
})

// Stato runtime client (per debug/monitoring)
app.get('/api/ctrader/health', (c) => c.json({
  ready: isCtraderReady(),
  symbols_cached: ctraderListSymbols().length,
}))

// ── Yahoo Finance fallback per forex / XAU / oil quando TwelveData quota esaurita.
// Niente API key, niente quota. Dati delayed 15-30 min (ok per analisi MTF/EMA/pattern).
app.get('/api/yahoo/candles', async (c) => {
  const symbol = c.req.query('symbol')
  const tf     = c.req.query('tf') || '1h'
  const count  = Number(c.req.query('count') || 500)
  if (!symbol) return c.json({ error: 'symbol required' }, 400)
  try {
    const result = await yahooFetchCandles(symbol, tf, count)
    return c.json(result)
  } catch (err) {
    console.error(`[yahoo] ${symbol} ${tf}:`, err.message)
    return c.json({ error: err.message, symbol, tf }, 500)
  }
})

app.get('/api/yahoo/symbols', (c) => c.json({ symbols: yahooListSymbols() }))

// ── Macro proxy (FF calendar, FRED yields, F&G Index) ────────────
// Sostituisce corsproxy.io che dà 403 frequentemente.
registerMacroRoutes(app)

// ── TradeLog per-utente (sync server-side del Review Lab)
// Tutte queste route sono dietro authMiddleware (user-specific).
registerTradeLogRoutes(app, env)

// ── cTrader FIX feed (FPMarkets live) — read-only quote session.
// L'utente lo avvia ESPLICITAMENTE via POST /api/fix/start. Niente auto-init
// allo startup: usa credenziali broker reali, deve restare scelta consapevole.
app.get('/api/fix/status', (c) => c.json(ctraderFixStatus()))
app.post('/api/fix/start', async (c) => {
  try {
    const ok = await ctraderFixInit()
    return c.json({ ok, status: ctraderFixStatus() })
  } catch (err) {
    return c.json({ error: err.message }, 500)
  }
})
app.post('/api/fix/stop', (c) => { ctraderFixStop(); return c.json({ ok: true, status: ctraderFixStatus() }) })
app.get('/api/fix/quote', (c) => {
  const symbol = c.req.query('symbol')
  if (!symbol) return c.json({ error: 'symbol required' }, 400)
  return c.json({ symbol, quote: ctraderFixGetCurrentQuote(symbol) })
})
app.get('/api/fix/candles', (c) => {
  const symbol = c.req.query('symbol')
  const tf     = c.req.query('tf') || '1h'
  const count  = Number(c.req.query('count') || 200)
  if (!symbol) return c.json({ error: 'symbol required' }, 400)
  const candles = ctraderFixGetCandles(symbol, tf, count)
  return c.json({ symbol, tf, candles, source: 'ctrader-fix' })
})

app.get('/api/news-cache', (c) => c.json(getNewsCacheStats()))

// Fix #2.4: TwelveData quota visibility — used/limit/remaining + reset day.
app.get('/api/health/twelvedata', (c) => c.json(getTdQuota()))

// Fix #2.1c: health-by-profile — quanti account totali, quanti blown, ratio,
// stato active + paused_reason/paused_at. Utile per dashboard ops.
app.get('/api/health/profiles', async (c) => {
  const { results } = await env.DB.prepare(`
    SELECT cfg.id, cfg.label, cfg.active, cfg.paused_reason, cfg.paused_at,
           cfg.starting_balance, cfg.broker_id,
           COUNT(a.account_key) AS total_accounts,
           SUM(CASE WHEN a.blown THEN 1 ELSE 0 END) AS blown_accounts
    FROM sim_config cfg
    LEFT JOIN sim_accounts a ON a.profile_id = cfg.id
    GROUP BY cfg.id
    ORDER BY cfg.id
  `).all()
  return c.json({
    profiles: results.map(r => ({
      ...r,
      active: !!r.active,
      blown_ratio: r.total_accounts > 0 ? r.blown_accounts / r.total_accounts : 0,
    })),
  })
})

app.get('/api/strategies', (c) => c.json({
  // Fix #4.1: nascondi dal client le strategie disabilitate (es. ema921).
  strategies: STRATEGIES.filter(s => s.enabled !== false).map(s => ({
    id: s.id, name: s.name, category: s.category, slMul: s.slMul, tpMul: s.tpMul,
  })),
}))

// ── Profili ────────────────────────────────────────────────────────
app.get('/api/profiles', async (c) => c.json({ profiles: await listProfiles() }))

// State (default profile=1, override con query ?profile=N)
app.get('/api/state', async (c) => {
  const pid = Number(c.req.query('profile')) || 1
  return c.json(await getState(pid))
})

// State multi-profile in un'unica chiamata
app.get('/api/profiles/:id/state', async (c) => {
  const pid = Number(c.req.param('id')) || 1
  return c.json(await getState(pid))
})

app.get('/api/accounts/:key', async (c) => {
  const detail = await getAccountDetail(c.req.param('key'))
  if (!detail) return c.json({ error: 'not found' }, 404)
  return c.json(detail)
})

// Lifecycle endpoint: legacy default profile 1 + new profile-specific
app.post('/api/start', async (c) => {
  const body = await c.req.json().catch(() => ({}))
  const pid = Number(body.profile_id) || 1
  return c.json(await startSim(body, pid))
})
app.post('/api/profiles/:id/start', async (c) => {
  const pid = Number(c.req.param('id')) || 1
  const body = await c.req.json().catch(() => ({}))
  return c.json(await startSim(body, pid))
})
app.post('/api/stop',   async (c) => {
  const pid = Number(c.req.query('profile')) || 1
  return c.json(await stopSim(pid))
})
app.post('/api/profiles/:id/stop', async (c) => c.json(await stopSim(Number(c.req.param('id')) || 1)))
app.post('/api/resume', async (c) => {
  const pid = Number(c.req.query('profile')) || 1
  return c.json(await resumeSim(pid))
})
app.post('/api/profiles/:id/resume', async (c) => c.json(await resumeSim(Number(c.req.param('id')) || 1)))
app.post('/api/reset',  async (c) => {
  const pid = c.req.query('profile') ? Number(c.req.query('profile')) : null
  // Footgun guard: reset globale (no profile) richiede confirm flag esplicito
  if (pid == null) {
    const body = await c.req.json().catch(() => ({}))
    const confirm = body?.confirm || c.req.query('confirm')
    if (confirm !== 'WIPE_ALL_PROFILES') {
      return c.json({
        error: 'global reset requires confirm flag',
        hint: 'POST { "confirm": "WIPE_ALL_PROFILES" } or use /api/profiles/:id/reset for single-profile reset',
      }, 400)
    }
  }
  return c.json(await resetSim(pid))
})
app.post('/api/profiles/:id/reset', async (c) => c.json(await resetSim(Number(c.req.param('id')) || 1)))
app.post('/api/tick',   async (c) => {
  // Fix #3.3: rate-limit manual /api/tick a 10/min per IP
  if (!rateLimit(c, 10, 60_000)) return c.json({ error: 'rate_limited' }, 429)
  return c.json(await runTick(env.DB, env))
})

app.onError((err, c) => {
  console.error('[HTTP] error:', err)
  return c.json({ error: err.message, stack: err.stack }, 500)
})

// ── Cron tick ogni minuto ─────────────────────────────────────────
// Fix #2.5: re-queue. Se un tick va lungo (>1 min) e arriva un secondo
// tick, invece di skippare-e-perdere, marchiamo `tickQueued = true` e
// rieseguiamo UN tick non appena il primo finisce. Un solo posto in coda
// (debounce di fatto) — evita stampede se i tick si accumulano.
let tickRunning = false
let tickQueued = false

// Refresh news cache ogni ora (separato dal tick principale)
cron.schedule('0 * * * *', async () => {
  try {
    const n = await refreshNewsCache()
    console.log(`[cron news] cache refreshed: ${n} eventi alto impatto`)
  } catch (err) {
    console.warn('[cron news] error:', err.message)
  }
})

// Cleanup sessioni scadute ogni ora (DELETE FROM sim_sessions WHERE expires_at < now)
cron.schedule('15 * * * *', async () => {
  try {
    const n = await cleanupExpiredSessions(env.DB)
    if (n > 0) console.log(`[cron auth] cleanup: ${n} sessioni scadute rimosse`)
  } catch (err) {
    console.error('[cron auth] cleanup error:', err)
  }
})

cron.schedule('* * * * *', async () => {
  if (tickRunning) {
    if (!tickQueued) {
      tickQueued = true
      console.warn('[cron] tick overlap, queued (will run after current tick)')
    }
    return
  }
  tickRunning = true
  try {
    const t0 = Date.now()
    const result = await runTick(env.DB, env)
    console.log(`[cron] tick ${JSON.stringify(result)} (${Date.now() - t0}ms)`)
    // Drain queued tick (al massimo 1, no loop infinito)
    if (tickQueued) {
      tickQueued = false
      console.log('[cron] running queued tick')
      const tq = Date.now()
      const r2 = await runTick(env.DB, env)
      console.log(`[cron] queued-tick ${JSON.stringify(r2)} (${Date.now() - tq}ms)`)
    }
  } catch (err) {
    console.error('[cron] tick error:', err)
  } finally {
    tickRunning = false
  }
})

// ── Start server ───────────────────────────────────────────────────
serve({ fetch: app.fetch, port: PORT, hostname: '0.0.0.0' }, (info) => {
  console.log(`✓ Impact Trading Server avviato su http://0.0.0.0:${info.port}`)
  console.log(`  CORS allowed: ${ALLOWED_ORIGINS.join(', ')}`)
  console.log(`  TwelveData keys configurate: ${[env.TWELVEDATA_API_KEY, env.TWELVEDATA_API_KEY_2].filter(Boolean).length}`)
  // Pre-fetch news cache all'avvio per avere il filter operativo subito
  refreshNewsCache().then(n => console.log(`  News cache: ${n} eventi alto impatto`))
                    .catch(err => console.warn('  News cache failed:', err.message))
  // Fix #5.14: init cTrader client lazy (no-op se OAuth non ancora fatto)
  initCtraderClient(env).then(c => {
    if (c) console.log(`  cTrader: connected, ${ctraderListSymbols().length} symbols cached`)
    else console.log('  cTrader: NOT connected (run /api/ctrader/auth/start)')
  }).catch(err => console.warn('  cTrader init failed:', err.message))
})
