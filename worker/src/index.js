// Impact Trading Worker · main entry
// Routes:
//   GET  /api/state           → leggi tutti gli account + config + last_tick
//   GET  /api/accounts        → solo account list
//   GET  /api/accounts/:key   → singolo account con trades + equity
//   POST /api/start           → avvia con config nel body JSON
//   POST /api/stop            → mette in pausa (preserva stato)
//   POST /api/resume          → riprende
//   POST /api/reset           → wipe completo
//   GET  /api/health          → ping
//
// Cron: scheduled() ogni minuto chiama runTick()
import { runTick, initAccounts } from './sim.js'
import { STRATEGIES } from './strategies.js'

// ── CORS ──────────────────────────────────────────────────────────
function corsHeaders(origin, env) {
  const allowed = (env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim())
  const allow = allowed.includes(origin) ? origin : allowed[0] || '*'
  return {
    'Access-Control-Allow-Origin':  allow,
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age':       '86400',
  }
}

function json(data, init = {}, origin, env) {
  return new Response(JSON.stringify(data), {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...corsHeaders(origin, env),
      ...(init.headers || {}),
    },
  })
}

// ── Routes handlers ────────────────────────────────────────────────
async function getState(db) {
  const cfg = await db.prepare('SELECT * FROM sim_config WHERE id = 1').first()
  const { results: accounts } = await db.prepare('SELECT * FROM sim_accounts').all()
  return {
    config: cfg ? {
      ...cfg,
      pairs: JSON.parse(cfg.pairs || '[]'),
      swing_strategies: JSON.parse(cfg.swing_strategies || '[]'),
      scalp_strategies: JSON.parse(cfg.scalp_strategies || '[]'),
      compounding: !!cfg.compounding,
      active: !!cfg.active,
    } : null,
    accounts: accounts.map(a => ({
      ...a,
      open_position: a.open_position ? JSON.parse(a.open_position) : null,
      blown: !!a.blown,
    })),
  }
}

async function getAccountDetail(db, key) {
  const acc = await db.prepare('SELECT * FROM sim_accounts WHERE account_key = ?').bind(key).first()
  if (!acc) return null
  const { results: trades } = await db.prepare(
    'SELECT * FROM sim_trades WHERE account_key = ? ORDER BY entry_time DESC LIMIT 100'
  ).bind(key).all()
  const { results: equity } = await db.prepare(
    'SELECT ts, balance FROM sim_equity WHERE account_key = ? ORDER BY ts ASC LIMIT 1000'
  ).bind(key).all()
  return {
    account: {
      ...acc,
      open_position: acc.open_position ? JSON.parse(acc.open_position) : null,
      blown: !!acc.blown,
    },
    trades,
    equity,
  }
}

async function startSim(db, body, env) {
  const cfg = {
    pairs: body.pairs || ['XAUUSD', 'BTCUSD', 'EURUSD', 'GBPUSD', 'USDJPY', 'GBPJPY', 'EURGBP', 'EURJPY'],
    swing_strategies: body.swing_strategies || STRATEGIES.filter(s => s.category === 'swing').map(s => s.id),
    scalp_strategies: body.scalp_strategies || STRATEGIES.filter(s => s.category === 'scalp').map(s => s.id),
    swing_tf: body.swing_tf || '4h',
    scalp_tf: body.scalp_tf || '15m',
    starting_balance: body.starting_balance || Number(env.DEFAULT_STARTING_BALANCE) || 1000,
    risk_pct: body.risk_pct || Number(env.DEFAULT_RISK_PCT) || 1,
    compounding: body.compounding !== false,
    broker_id: body.broker_id || env.DEFAULT_BROKER_ID || 'fpmarkets_raw',
  }

  const now = Math.floor(Date.now() / 1000)
  await db.prepare(
    `INSERT INTO sim_config
       (id, active, started_at, stopped_at, pairs, swing_strategies, scalp_strategies,
        swing_tf, scalp_tf, starting_balance, risk_pct, compounding, broker_id, cycles, updated_at)
     VALUES (1, 1, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)
     ON CONFLICT(id) DO UPDATE SET
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
    now,
    JSON.stringify(cfg.pairs),
    JSON.stringify(cfg.swing_strategies),
    JSON.stringify(cfg.scalp_strategies),
    cfg.swing_tf, cfg.scalp_tf,
    cfg.starting_balance, cfg.risk_pct,
    cfg.compounding ? 1 : 0,
    cfg.broker_id, now
  ).run()

  const created = await initAccounts(db, cfg)
  return { ok: true, accounts_initialized: created }
}

async function stopSim(db) {
  await db.prepare(
    `UPDATE sim_config SET active = 0, stopped_at = ?, updated_at = ? WHERE id = 1`
  ).bind(Math.floor(Date.now() / 1000), Math.floor(Date.now() / 1000)).run()
  return { ok: true }
}

async function resumeSim(db) {
  await db.prepare(
    `UPDATE sim_config SET active = 1, stopped_at = NULL, updated_at = ? WHERE id = 1`
  ).bind(Math.floor(Date.now() / 1000)).run()
  return { ok: true }
}

async function resetSim(db) {
  await db.batch([
    db.prepare('DELETE FROM sim_trades'),
    db.prepare('DELETE FROM sim_equity'),
    db.prepare('DELETE FROM sim_accounts'),
    db.prepare('DELETE FROM sim_errors'),
    db.prepare('DELETE FROM candle_cache'),
    db.prepare('DELETE FROM sim_config WHERE id = 1'),
  ])
  return { ok: true }
}

// ── Main fetch handler ─────────────────────────────────────────────
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url)
    const origin = request.headers.get('Origin') || ''

    // CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders(origin, env) })
    }

    const db = env.DB

    try {
      // GET /api/health
      if (url.pathname === '/api/health') {
        return json({ ok: true, ts: Date.now() }, {}, origin, env)
      }

      // GET /api/strategies
      if (url.pathname === '/api/strategies' && request.method === 'GET') {
        return json({
          strategies: STRATEGIES.map(s => ({
            id: s.id, name: s.name, category: s.category, slMul: s.slMul, tpMul: s.tpMul,
          })),
        }, {}, origin, env)
      }

      // GET /api/state
      if (url.pathname === '/api/state' && request.method === 'GET') {
        const state = await getState(db)
        return json(state, {}, origin, env)
      }

      // GET /api/accounts/:key
      const accountMatch = url.pathname.match(/^\/api\/accounts\/(.+)$/)
      if (accountMatch && request.method === 'GET') {
        const detail = await getAccountDetail(db, decodeURIComponent(accountMatch[1]))
        if (!detail) return json({ error: 'not found' }, { status: 404 }, origin, env)
        return json(detail, {}, origin, env)
      }

      // POST /api/start
      if (url.pathname === '/api/start' && request.method === 'POST') {
        const body = await request.json().catch(() => ({}))
        const result = await startSim(db, body, env)
        return json(result, {}, origin, env)
      }

      // POST /api/stop
      if (url.pathname === '/api/stop' && request.method === 'POST') {
        return json(await stopSim(db), {}, origin, env)
      }

      // POST /api/resume
      if (url.pathname === '/api/resume' && request.method === 'POST') {
        return json(await resumeSim(db), {}, origin, env)
      }

      // POST /api/reset
      if (url.pathname === '/api/reset' && request.method === 'POST') {
        return json(await resetSim(db), {}, origin, env)
      }

      // POST /api/tick → manual trigger del cron (utile per debug)
      if (url.pathname === '/api/tick' && request.method === 'POST') {
        const result = await runTick(db, env)
        return json(result, {}, origin, env)
      }

      return json({ error: 'not found', path: url.pathname }, { status: 404 }, origin, env)
    } catch (err) {
      return json({ error: err.message, stack: err.stack }, { status: 500 }, origin, env)
    }
  },

  // ── Cron handler: chiamato ogni minuto ───────────────────────────
  async scheduled(event, env, ctx) {
    ctx.waitUntil(
      runTick(env.DB, env).catch(err => {
        console.error('[Worker cron] tick error:', err)
      })
    )
  },
}
