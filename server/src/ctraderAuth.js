// cTrader Open API OAuth2 flow
// Doc: https://help.ctrader.com/open-api/account-authentication/
//
// Flow:
// 1. Generate authorize URL → user opens, authorizes app on cTrader
// 2. cTrader redirects to redirect_uri?code=XXX
// 3. Backend exchanges code → access_token + refresh_token
// 4. Token saved in sim DB (table ctrader_tokens, single-row)
// 5. Refresh access_token automatically before expiry (30 days)

const OAUTH_BASE = 'https://openapi.ctrader.com'
const REFRESH_BEFORE_EXPIRY_SEC = 24 * 3600   // refresh 1 giorno prima della scadenza

export function buildAuthorizeUrl(env) {
  const clientId    = env.CTRADER_CLIENT_ID
  const redirectUri = env.CTRADER_REDIRECT_URI
  if (!clientId || !redirectUri) {
    throw new Error('CTRADER_CLIENT_ID o CTRADER_REDIRECT_URI mancanti in .env')
  }
  const params = new URLSearchParams({
    response_type: 'code',
    client_id:     clientId,
    redirect_uri:  redirectUri,
    scope:         'accounts',
  })
  return `${OAUTH_BASE}/apps/auth?${params.toString()}`
}

export async function exchangeCodeForToken(code, env) {
  const params = new URLSearchParams({
    grant_type:    'authorization_code',
    code,
    client_id:     env.CTRADER_CLIENT_ID,
    client_secret: env.CTRADER_CLIENT_SECRET,
    redirect_uri:  env.CTRADER_REDIRECT_URI,
  })
  const res = await fetch(`${OAUTH_BASE}/apps/token?${params.toString()}`, { method: 'POST' })
  if (!res.ok) {
    const txt = await res.text()
    throw new Error(`cTrader token exchange failed: ${res.status} ${txt}`)
  }
  return res.json()
}

export async function refreshToken(refreshTokenStr, env) {
  const params = new URLSearchParams({
    grant_type:    'refresh_token',
    refresh_token: refreshTokenStr,
    client_id:     env.CTRADER_CLIENT_ID,
    client_secret: env.CTRADER_CLIENT_SECRET,
  })
  const res = await fetch(`${OAUTH_BASE}/apps/token?${params.toString()}`, { method: 'POST' })
  if (!res.ok) {
    const txt = await res.text()
    throw new Error(`cTrader token refresh failed: ${res.status} ${txt}`)
  }
  return res.json()
}

export async function listAccounts(accessToken) {
  const res = await fetch(`${OAUTH_BASE}/connect/tradingaccounts`, {
    headers: { 'Authorization': `Bearer ${accessToken}` },
  })
  if (!res.ok) {
    const txt = await res.text()
    throw new Error(`cTrader listAccounts failed: ${res.status} ${txt}`)
  }
  const data = await res.json()
  return data.data || []
}

export async function saveTokens(db, tokenSet) {
  const now = Math.floor(Date.now() / 1000)
  const expiresAt = now + (tokenSet.expires_in || 86400 * 30)
  const refreshExpiresAt = now + (tokenSet.refresh_token_expires_in || 86400 * 30)
  await db.prepare(`
    INSERT INTO ctrader_tokens (id, access_token, refresh_token, token_type, scope,
      expires_at, refresh_expires_at, created_at, updated_at)
    VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      access_token       = excluded.access_token,
      refresh_token      = excluded.refresh_token,
      token_type         = excluded.token_type,
      scope              = excluded.scope,
      expires_at         = excluded.expires_at,
      refresh_expires_at = excluded.refresh_expires_at,
      updated_at         = excluded.updated_at
  `).bind(
    tokenSet.access_token, tokenSet.refresh_token,
    tokenSet.token_type || 'bearer', tokenSet.scope || 'accounts',
    expiresAt, refreshExpiresAt, now, now,
  ).run()
}

export async function loadTokens(db) {
  return db.prepare('SELECT * FROM ctrader_tokens WHERE id = 1').first()
}

export async function getValidAccessToken(db, env) {
  const tokens = await loadTokens(db)
  if (!tokens) return null
  const now = Math.floor(Date.now() / 1000)
  if (tokens.expires_at > now + REFRESH_BEFORE_EXPIRY_SEC) {
    return tokens.access_token
  }
  console.log('[cTrader] access_token in scadenza, refresh in corso...')
  const newTokens = await refreshToken(tokens.refresh_token, env)
  await saveTokens(db, newTokens)
  return newTokens.access_token
}

export function makeCtraderAuthRoutes(env) {
  return {
    start: async (c) => {
      try {
        return c.redirect(buildAuthorizeUrl(env))
      } catch (err) {
        return c.json({ error: err.message }, 500)
      }
    },
    callback: async (c) => {
      const code  = c.req.query('code')
      const error = c.req.query('error')
      if (error) return c.html(`<h1>cTrader auth error</h1><p>${error}</p>`, 400)
      if (!code) return c.html('<h1>Missing code</h1>', 400)
      try {
        const tokenSet = await exchangeCodeForToken(code, env)
        await saveTokens(env.DB, tokenSet)
        const accounts = await listAccounts(tokenSet.access_token)
        const accountsHtml = accounts.map(a =>
          `<li><b>${a.traderLogin}</b> · ${a.brokerName} · ${a.live ? 'LIVE' : 'DEMO'} · ${a.depositCurrency} · €${(a.balance / 100).toFixed(2)}</li>`
        ).join('')
        return c.html(`<!doctype html><html><head>
          <title>cTrader Autorizzato</title>
          <style>body{font-family:system-ui;background:#0a0a0a;color:#fff;padding:2rem;max-width:600px;margin:auto}
            h1{color:#00e096}h2{color:#f5c842;margin-top:2rem}
            li{padding:0.5rem;background:#1a1a1a;margin:0.3rem 0;border-radius:4px;list-style:none}
            a{color:#3b82f6}</style></head><body>
          <h1>cTrader autorizzato con successo</h1>
          <p>Access token salvato. Scope: <code>${tokenSet.scope}</code></p>
          <h2>Account disponibili (${accounts.length})</h2>
          <ul>${accountsHtml}</ul>
          <p><a href="/">Torna alla dashboard</a></p>
        </body></html>`)
      } catch (err) {
        return c.html(`<h1>Errore</h1><pre>${err.message}</pre>`, 500)
      }
    },
    status: async (c) => {
      const tokens = await loadTokens(env.DB)
      if (!tokens) return c.json({ connected: false })
      const now = Math.floor(Date.now() / 1000)
      return c.json({
        connected: true,
        scope: tokens.scope,
        account_id: tokens.account_id,
        account_label: tokens.account_label,
        is_live: !!tokens.is_live,
        access_expires_in_sec: tokens.expires_at - now,
        refresh_expires_in_sec: tokens.refresh_expires_at - now,
      })
    },
    accounts: async (c) => {
      try {
        const token = await getValidAccessToken(env.DB, env)
        if (!token) return c.json({ error: 'not_authorized' }, 401)
        const accounts = await listAccounts(token)
        return c.json({ accounts })
      } catch (err) {
        return c.json({ error: err.message }, 500)
      }
    },
  }
}
