// Migration test — Phase 2+3 schema additions (0004_phase234_auth_blown_dedup.sql)
//
// IMPORTANT: questo test richiede better-sqlite3 installato. In env CI
// pulito (npm install non ancora eseguito) verra' SKIPPED.
//
// Copertura:
//   - Tabella sim_users creata con colonne attese
//   - Tabella sim_sessions creata con colonne attese e index
//   - sim_config ha colonne paused_reason, paused_at (Phase 2.1)
//   - sim_accounts ha colonna last_equity_write (Phase 2.8)
//   - migration applicabile in modo idempotente (1 sola volta)
//
// Eseguito con: node --test tests/migration.test.js

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'

const __dirname = dirname(fileURLToPath(import.meta.url))
const MIG_DIR = join(__dirname, '..', 'migrations')

let betterSqliteAvailable = false
let Database
try {
  const mod = await import('better-sqlite3')
  Database = mod.default
  betterSqliteAvailable = true
} catch {
  console.warn('[migration.test] better-sqlite3 NON installato — test SKIPPED')
}

const skipIfNoSqlite = (t) => {
  if (!betterSqliteAvailable) {
    t.skip('better-sqlite3 non installato in questo env')
    return true
  }
  return false
}

function makeTempDb() {
  // in-memory DB: ogni test e' isolato e veloce
  return new Database(':memory:')
}

function applyMigration(db, file) {
  const sql = readFileSync(join(MIG_DIR, file), 'utf8')
  db.exec(sql)
}

describe('migration 0004 — Phase 2+3 schema', () => {
  it('applica 0001+0002+0003 base, poi 0004 — sim_users + sim_sessions create', (t) => {
    if (skipIfNoSqlite(t)) return
    const db = makeTempDb()
    applyMigration(db, '0001_init.sql')
    applyMigration(db, '0002_multi_profile.sql')
    applyMigration(db, '0003_migration_runner_and_skip_log.sql')
    applyMigration(db, '0004_phase234_auth_blown_dedup.sql')

    // sim_users
    const usersCols = db.prepare("PRAGMA table_info('sim_users')").all().map(r => r.name)
    assert.ok(usersCols.includes('id'))
    assert.ok(usersCols.includes('username'))
    assert.ok(usersCols.includes('password_hash'))
    assert.ok(usersCols.includes('role'))
    assert.ok(usersCols.includes('created_at'))
    assert.ok(usersCols.includes('last_login_at'))

    // sim_sessions
    const sessCols = db.prepare("PRAGMA table_info('sim_sessions')").all().map(r => r.name)
    assert.ok(sessCols.includes('id'))
    assert.ok(sessCols.includes('user_id'))
    assert.ok(sessCols.includes('created_at'))
    assert.ok(sessCols.includes('expires_at'))
    assert.ok(sessCols.includes('ip'))
    assert.ok(sessCols.includes('user_agent'))

    // Index
    const idx = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='sim_sessions'"
    ).all().map(r => r.name)
    assert.ok(idx.includes('idx_sim_sessions_expires'))
    assert.ok(idx.includes('idx_sim_sessions_user'))
  })

  it('sim_config ha paused_reason e paused_at dopo 0004', (t) => {
    if (skipIfNoSqlite(t)) return
    const db = makeTempDb()
    applyMigration(db, '0001_init.sql')
    applyMigration(db, '0002_multi_profile.sql')
    applyMigration(db, '0003_migration_runner_and_skip_log.sql')
    applyMigration(db, '0004_phase234_auth_blown_dedup.sql')

    const cols = db.prepare("PRAGMA table_info('sim_config')").all().map(r => r.name)
    assert.ok(cols.includes('paused_reason'), 'paused_reason aggiunta')
    assert.ok(cols.includes('paused_at'), 'paused_at aggiunta')
  })

  it('sim_accounts ha last_equity_write dopo 0004', (t) => {
    if (skipIfNoSqlite(t)) return
    const db = makeTempDb()
    applyMigration(db, '0001_init.sql')
    applyMigration(db, '0002_multi_profile.sql')
    applyMigration(db, '0003_migration_runner_and_skip_log.sql')
    applyMigration(db, '0004_phase234_auth_blown_dedup.sql')

    const cols = db.prepare("PRAGMA table_info('sim_accounts')").all()
    const lew = cols.find(c => c.name === 'last_equity_write')
    assert.ok(lew, 'last_equity_write aggiunta')
    // Default 0
    assert.equal(lew.dflt_value, '0', 'default 0')
  })

  it('IF NOT EXISTS rende sim_users / sim_sessions idempotenti', (t) => {
    if (skipIfNoSqlite(t)) return
    const db = makeTempDb()
    applyMigration(db, '0001_init.sql')
    applyMigration(db, '0002_multi_profile.sql')
    applyMigration(db, '0003_migration_runner_and_skip_log.sql')
    applyMigration(db, '0004_phase234_auth_blown_dedup.sql')

    // Second apply CREATE TABLE IF NOT EXISTS no-op
    // ALTER TABLE ADD COLUMN NON e idempotente — una seconda exec genererebbe
    // "duplicate column name" error. Il runner di db.js gestisce questo
    // tramite la table _migrations (lookup esatto del file applicato),
    // quindi simuliamo SOLO le sezioni IDEMPOTENTI di 0004.
    const sql = readFileSync(join(MIG_DIR, '0004_phase234_auth_blown_dedup.sql'), 'utf8')
    const idempotent = sql
      .split('\n')
      .filter(l => !l.trim().startsWith('ALTER TABLE'))
      .join('\n')
    // Re-exec senza errori
    db.exec(idempotent)
  })
})
