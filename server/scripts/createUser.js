#!/usr/bin/env node
// Bootstrap CLI: crea un utente admin con password bcrypt (cost=12).
//
// Usage:
//   node scripts/createUser.js <username> <password>
//
// Esempi:
//   node scripts/createUser.js stefano 'M1aP@ssw0rd-S1cura!'
//
// Vincoli:
//   - password >= 8 char
//   - username deve essere UNIQUE (errore se esiste già)
//   - role default = 'admin'
//
// NOTA: usa lo stesso d1Adapter del server, quindi punta allo stesso DB
//       (server/data/impact.db) — esegui da dentro server/.

import 'dotenv/config'
import bcrypt from 'bcryptjs'
import { d1Adapter, initSchema } from '../src/db.js'

const [, , username, password] = process.argv

if (!username || !password) {
  console.error('Usage: node scripts/createUser.js <username> <password>')
  process.exit(1)
}

if (password.length < 8) {
  console.error('Password troppo corta (min 8 char)')
  process.exit(1)
}

// Bootstrap schema (idempotente — applica migration 0001..0004 se necessario)
initSchema()
const db = d1Adapter()

const existing = await db.prepare('SELECT id FROM sim_users WHERE username = ?').bind(username).first()
if (existing) {
  console.error(`User '${username}' esiste gia (id=${existing.id})`)
  process.exit(2)
}

const hash = await bcrypt.hash(password, 12)
const now = Math.floor(Date.now() / 1000)
await db.prepare(
  'INSERT INTO sim_users (username, password_hash, role, created_at) VALUES (?, ?, ?, ?)'
).bind(username, hash, 'admin', now).run()

console.log(`OK — user '${username}' creato come admin (bcrypt cost=12)`)
process.exit(0)
