// DB layer SQLite — sostituisce D1 del Worker.
// API simile a D1: db.prepare(sql).bind(...).run() / .first() / .all()
import Database from 'better-sqlite3'
import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))

let _db = null

export function getDb() {
  if (_db) return _db
  const dbPath = process.env.DB_PATH || join(__dirname, '..', 'data', 'impact.db')
  _db = new Database(dbPath)
  _db.pragma('journal_mode = WAL')
  _db.pragma('foreign_keys = ON')
  return _db
}

// Adapter per usare la stessa API del Worker (D1-like)
// Esempio: await db.prepare('...').bind(a, b).run()
export function d1Adapter() {
  const db = getDb()
  return {
    prepare(sql) {
      return new PreparedStatement(db.prepare(sql))
    },
    async batch(statements) {
      const tx = db.transaction((stmts) => {
        for (const s of stmts) s._exec()
      })
      tx(statements)
      return statements.map(() => ({ success: true }))
    },
  }
}

class PreparedStatement {
  constructor(stmt) {
    this._stmt = stmt
    this._params = []
  }
  bind(...params) {
    this._params = params
    return this
  }
  async first() {
    return this._stmt.get(...this._params) || null
  }
  async all() {
    return { results: this._stmt.all(...this._params) }
  }
  async run() {
    return this._stmt.run(...this._params)
  }
  // Per .batch()
  _exec() {
    return this._stmt.run(...this._params)
  }
}

// ── Init schema (migration runner idempotente) ─────────────────────
export function initSchema() {
  const db = getDb()
  // Tabella di tracking migration (creata anche da 0003 ma serve qui per le 0001/0002)
  db.exec(`CREATE TABLE IF NOT EXISTS _migrations (
    name TEXT PRIMARY KEY,
    applied_at INTEGER NOT NULL
  )`)

  // Backfill: se _migrations è vuota ma sim_config esiste già con profile_id,
  // significa che 0001 e 0002 sono state applicate prima dell'introduzione del runner.
  // Le marchiamo come applicate per evitare ri-esecuzione (DROP TABLE distruttivo in 0002).
  const migCount = db.prepare('SELECT COUNT(*) AS n FROM _migrations').get().n
  if (migCount === 0) {
    const hasSimConfig = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='sim_config'"
    ).get()
    if (hasSimConfig) {
      const cols = db.prepare("PRAGMA table_info('sim_config')").all()
      const hasLabel = cols.some(c => c.name === 'label')
      const accCols = db.prepare("PRAGMA table_info('sim_accounts')").all()
      const hasProfileId = accCols.some(c => c.name === 'profile_id')
      const now = Math.floor(Date.now() / 1000)
      db.prepare('INSERT OR IGNORE INTO _migrations (name, applied_at) VALUES (?, ?)')
        .run('0001_init.sql', now)
      // 0002 introduce 'label' su sim_config e 'profile_id' su sim_accounts
      if (hasLabel && hasProfileId) {
        db.prepare('INSERT OR IGNORE INTO _migrations (name, applied_at) VALUES (?, ?)')
          .run('0002_multi_profile.sql', now)
      }
      console.log('[DB] backfill _migrations per DB pre-esistente')
    }
  }

  const migDir = join(__dirname, '..', 'migrations')
  const files = readdirSync(migDir)
    .filter(f => /^\d{4}_.+\.sql$/.test(f))
    .sort()
  const applied = new Set(
    db.prepare('SELECT name FROM _migrations').all().map(r => r.name)
  )
  const tx = db.transaction(() => {
    for (const f of files) {
      if (applied.has(f)) continue
      const sql = readFileSync(join(migDir, f), 'utf8')
      db.exec(sql)
      db.prepare('INSERT INTO _migrations (name, applied_at) VALUES (?, ?)')
        .run(f, Math.floor(Date.now() / 1000))
      console.log(`[DB] applied migration ${f}`)
    }
  })
  tx()
  console.log('[DB] schema sincronizzato')
}

// ── CLI: --init ────────────────────────────────────────────────────
if (process.argv.includes('--init')) {
  initSchema()
  process.exit(0)
}
