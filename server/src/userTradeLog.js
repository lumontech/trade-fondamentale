// userTradeLog.js — CRUD server-side del TradeLog per-utente.
// Espone:
//   listTradeLog(db, userId, { since?, limit?, status? })
//   upsertTradeLog(db, userId, entry)
//   deleteTradeLog(db, userId, id)
//   bulkUpsertTradeLog(db, userId, entries[])  ← per sync iniziale

function rowToEntry(row) {
  if (!row) return null
  return {
    id:          row.id,
    openedAt:    row.opened_at,
    closedAt:    row.closed_at,
    status:      row.status,
    symbol:      row.symbol,
    timeframe:   row.timeframe,
    direction:   row.direction,
    confidence:  row.confidence,
    entryPrice:  row.entry_price,
    suggestedSL: row.suggested_sl,
    suggestedTP: row.suggested_tp,
    exitPrice:   row.exit_price,
    pnl:         row.pnl,
    pnlPct:      row.pnl_pct,
    rMultiple:   row.r_multiple,
    reasons:     row.reasons_json ? safeParse(row.reasons_json) : [],
    blockers:    row.blockers_json ? safeParse(row.blockers_json) : [],
    contextSnapshot: row.context_json ? safeParse(row.context_json) : null,
    notes:       row.notes || '',
    mode:        row.mode || null,
    updatedAt:   row.updated_at,
  }
}
function safeParse(s) { try { return JSON.parse(s) } catch { return null } }

export async function listTradeLog(db, userId, opts = {}) {
  const { since = 0, limit = 500, status = null, symbol = null } = opts
  let sql = 'SELECT * FROM sim_user_trade_log WHERE user_id = ? AND opened_at >= ?'
  const args = [userId, since]
  if (status) { sql += ' AND status = ?'; args.push(status) }
  if (symbol) { sql += ' AND symbol = ?'; args.push(symbol) }
  sql += ' ORDER BY opened_at DESC LIMIT ?'
  args.push(limit)
  const rows = await db.prepare(sql).bind(...args).all()
  return (rows.results || rows).map(rowToEntry)
}

export async function getTradeLogEntry(db, userId, id) {
  const row = await db.prepare(
    'SELECT * FROM sim_user_trade_log WHERE user_id = ? AND id = ?'
  ).bind(userId, id).first()
  return rowToEntry(row)
}

export async function upsertTradeLog(db, userId, entry) {
  if (!entry?.id) throw new Error('entry.id required')
  const now = Date.now()
  // LWW: aggiorna solo se l'entry nuovo ha updatedAt ≥ esistente
  const existing = await db.prepare(
    'SELECT updated_at FROM sim_user_trade_log WHERE user_id = ? AND id = ?'
  ).bind(userId, entry.id).first()
  const existingUpd = existing?.updated_at ?? 0
  const newUpd = entry.updatedAt ?? now
  if (existing && newUpd < existingUpd) {
    // Server è più nuovo, skip write
    return { saved: false, reason: 'server_newer', server_updated_at: existingUpd }
  }
  const stringify = (v) => v == null ? null : (typeof v === 'string' ? v : JSON.stringify(v))
  await db.prepare(`
    INSERT INTO sim_user_trade_log (
      id, user_id, opened_at, closed_at, status, symbol, timeframe, direction, confidence,
      entry_price, suggested_sl, suggested_tp, exit_price, pnl, pnl_pct, r_multiple,
      reasons_json, blockers_json, context_json, notes, mode, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      opened_at=excluded.opened_at, closed_at=excluded.closed_at, status=excluded.status,
      symbol=excluded.symbol, timeframe=excluded.timeframe, direction=excluded.direction,
      confidence=excluded.confidence, entry_price=excluded.entry_price,
      suggested_sl=excluded.suggested_sl, suggested_tp=excluded.suggested_tp,
      exit_price=excluded.exit_price, pnl=excluded.pnl, pnl_pct=excluded.pnl_pct,
      r_multiple=excluded.r_multiple, reasons_json=excluded.reasons_json,
      blockers_json=excluded.blockers_json, context_json=excluded.context_json,
      notes=excluded.notes, mode=excluded.mode, updated_at=excluded.updated_at
  `).bind(
    entry.id, userId,
    entry.openedAt ?? now,
    entry.closedAt ?? null,
    entry.status ?? 'open',
    entry.symbol, entry.timeframe, entry.direction,
    entry.confidence ?? null,
    entry.entryPrice ?? null,
    entry.suggestedSL ?? null,
    entry.suggestedTP ?? null,
    entry.exitPrice ?? null,
    entry.pnl ?? null,
    entry.pnlPct ?? null,
    entry.rMultiple ?? null,
    stringify(entry.reasons),
    stringify(entry.blockers),
    stringify(entry.contextSnapshot),
    entry.notes ?? '',
    entry.mode ?? entry.contextSnapshot?.analysis_mode ?? null,
    newUpd,
  ).run()
  return { saved: true, updated_at: newUpd }
}

export async function deleteTradeLog(db, userId, id) {
  const r = await db.prepare(
    'DELETE FROM sim_user_trade_log WHERE user_id = ? AND id = ?'
  ).bind(userId, id).run()
  return { deleted: (r?.changes ?? r?.meta?.changes ?? 0) > 0 }
}

export async function bulkUpsertTradeLog(db, userId, entries) {
  const results = []
  for (const e of entries) {
    try {
      const r = await upsertTradeLog(db, userId, e)
      results.push({ id: e.id, ...r })
    } catch (err) {
      results.push({ id: e.id, saved: false, error: err.message })
    }
  }
  return results
}

// ── Hono route registration ────────────────────────────────────────
// `env` deve essere passato dal chiamante (es. index.js) ed esporre env.DB
// del d1Adapter. Pattern identico a userApiKeys.
export function registerTradeLogRoutes(app, env) {
  // GET /api/user/trade-log  → lista paginata
  app.get('/api/user/trade-log', async (c) => {
    const user = c.get('user')
    if (!user) return c.json({ error: 'unauthorized' }, 401)
    const since = Number(c.req.query('since') || 0)
    const limit = Math.min(Number(c.req.query('limit') || 500), 2000)
    const status = c.req.query('status') || null
    const symbol = c.req.query('symbol') || null
    try {
      const entries = await listTradeLog(env.DB, user.user_id, { since, limit, status, symbol })
      return c.json({ entries, count: entries.length })
    } catch (err) {
      console.error('[tradeLog] list error:', err.message)
      return c.json({ error: err.message }, 500)
    }
  })

  // PUT /api/user/trade-log  → upsert singolo entry
  app.put('/api/user/trade-log', async (c) => {
    const user = c.get('user')
    if (!user) return c.json({ error: 'unauthorized' }, 401)
    try {
      const entry = await c.req.json()
      if (!entry?.id) return c.json({ error: 'id required' }, 400)
      const r = await upsertTradeLog(env.DB, user.user_id, entry)
      return c.json(r)
    } catch (err) {
      console.error('[tradeLog] upsert error:', err.message)
      return c.json({ error: err.message }, 500)
    }
  })

  // POST /api/user/trade-log/bulk  → bulk upsert (per sync iniziale)
  app.post('/api/user/trade-log/bulk', async (c) => {
    const user = c.get('user')
    if (!user) return c.json({ error: 'unauthorized' }, 401)
    try {
      const body = await c.req.json()
      if (!Array.isArray(body?.entries)) return c.json({ error: 'entries[] required' }, 400)
      if (body.entries.length > 1000) return c.json({ error: 'max 1000 entries per bulk' }, 400)
      const results = await bulkUpsertTradeLog(env.DB, user.user_id, body.entries)
      const saved = results.filter(r => r.saved).length
      return c.json({ saved, total: results.length, results })
    } catch (err) {
      console.error('[tradeLog] bulk error:', err.message)
      return c.json({ error: err.message }, 500)
    }
  })

  // DELETE /api/user/trade-log/:id
  app.delete('/api/user/trade-log/:id', async (c) => {
    const user = c.get('user')
    if (!user) return c.json({ error: 'unauthorized' }, 401)
    const id = c.req.param('id')
    try {
      const r = await deleteTradeLog(env.DB, user.user_id, id)
      return c.json(r)
    } catch (err) {
      console.error('[tradeLog] delete error:', err.message)
      return c.json({ error: err.message }, 500)
    }
  })

  // GET /api/user/trade-log/status  → stats summary (per AuthGuard sync check)
  app.get('/api/user/trade-log/status', async (c) => {
    const user = c.get('user')
    if (!user) return c.json({ error: 'unauthorized' }, 401)
    try {
      const row = await env.DB.prepare(
        'SELECT COUNT(*) as total, MAX(updated_at) as last_updated FROM sim_user_trade_log WHERE user_id = ?'
      ).bind(user.user_id).first()
      return c.json({
        total: row?.total || 0,
        last_updated: row?.last_updated || null,
      })
    } catch (err) {
      return c.json({ error: err.message }, 500)
    }
  })
}
