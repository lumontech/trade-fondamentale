// userApiKeys.js — gestione API key per utente con encryption at rest (AES-256-GCM).
//
// Flusso:
//   1. Server legge API_KEYS_SECRET dal .env (raccomandato: 64 char hex casuali)
//   2. SHA-256(API_KEYS_SECRET) → chiave AES 32 byte
//   3. Encrypt: AES-256-GCM, IV random 12 byte, auth tag 16 byte → tutto base64
//   4. Storage SQLite tabella sim_user_api_keys (user_id, service, encrypted, iv, tag)
//   5. Decrypt on-read per servire al frontend (user autenticato via session cookie)
//
// Senza API_KEYS_SECRET il salvataggio FALLISCE volutamente — meglio rifiutare
// piuttosto che scrivere plaintext per errore.

import crypto from 'node:crypto'

// Servizi accettati (whitelist anti-spam DB)
const ALLOWED_SERVICES = new Set([
  'anthropic',     // Claude API
  'twelvedata',    // TwelveData primaria
  'twelvedata2',   // TwelveData seconda chiave (load balance)
  'finnhub',       // News + crypto data
  'fred',          // Federal Reserve macro
  'coingecko',     // Crypto market cap
  'apify',         // Social sentiment scraping
  'newsapi',       // News alt provider
])

let _cachedKey = null
function getMasterKey() {
  if (_cachedKey) return _cachedKey
  const secret = process.env.API_KEYS_SECRET
  if (!secret || secret.length < 16) {
    throw new Error('API_KEYS_SECRET missing or too short (min 16 chars). Add to server .env.')
  }
  _cachedKey = crypto.createHash('sha256').update(secret).digest()
  return _cachedKey
}

function encrypt(plaintext) {
  const key = getMasterKey()
  const iv = crypto.randomBytes(12)
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv)
  const enc = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()
  return {
    encrypted: enc.toString('base64'),
    iv:        iv.toString('base64'),
    tag:       tag.toString('base64'),
  }
}

function decrypt({ encrypted, iv, tag }) {
  const key = getMasterKey()
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64'))
  decipher.setAuthTag(Buffer.from(tag, 'base64'))
  const dec = Buffer.concat([
    decipher.update(Buffer.from(encrypted, 'base64')),
    decipher.final(),
  ])
  return dec.toString('utf8')
}

// ── DAO ─────────────────────────────────────────────────────────────
export async function listUserApiKeys(db, userId) {
  const rows = await db.prepare(
    'SELECT service, encrypted, iv, tag FROM sim_user_api_keys WHERE user_id = ?'
  ).bind(userId).all()
  const out = {}
  const list = rows?.results || rows || []
  for (const r of list) {
    try { out[r.service] = decrypt(r) }
    catch (e) {
      console.warn(`[userApiKeys] decrypt failed for user ${userId} service ${r.service}:`, e.message)
      // Skippa: probabilmente API_KEYS_SECRET è cambiata, l'utente reinserisce
    }
  }
  return out
}

export async function setUserApiKey(db, userId, service, key) {
  if (!ALLOWED_SERVICES.has(service)) throw new Error(`Service not allowed: ${service}`)
  if (typeof key !== 'string') throw new Error('Key must be string')
  const trimmed = key.trim()
  if (trimmed.length > 500) throw new Error('Key too long (max 500 chars)')

  // Empty string = delete
  if (trimmed === '') {
    await db.prepare(
      'DELETE FROM sim_user_api_keys WHERE user_id = ? AND service = ?'
    ).bind(userId, service).run()
    return { deleted: true }
  }

  const { encrypted, iv, tag } = encrypt(trimmed)
  const now = Math.floor(Date.now() / 1000)

  // UPSERT (SQLite)
  await db.prepare(`
    INSERT INTO sim_user_api_keys (user_id, service, encrypted, iv, tag, updated_at)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT (user_id, service) DO UPDATE SET
      encrypted = excluded.encrypted,
      iv        = excluded.iv,
      tag       = excluded.tag,
      updated_at = excluded.updated_at
  `).bind(userId, service, encrypted, iv, tag, now).run()

  return { saved: true, updated_at: now }
}

export async function deleteUserApiKey(db, userId, service) {
  await db.prepare(
    'DELETE FROM sim_user_api_keys WHERE user_id = ? AND service = ?'
  ).bind(userId, service).run()
  return { deleted: true }
}

// ── Diagnostica ────────────────────────────────────────────────────
export function getCryptoStatus() {
  try {
    getMasterKey()
    return { ok: true, allowed_services: [...ALLOWED_SERVICES] }
  } catch (e) {
    return { ok: false, error: e.message, allowed_services: [...ALLOWED_SERVICES] }
  }
}
