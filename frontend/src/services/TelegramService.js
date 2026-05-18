// TelegramService — legge messaggi da canali Telegram pubblici tramite Bot API.
// Richiede:
// 1) Bot token (creato con @BotFather)
// 2) Bot ADMIN nei canali da leggere (Telegram non permette read di canali a cui il bot non è iscritto)
// 3) Channel @username pubblici (es: "@forexsignalsfree")
//
// Per leggere canali privati o gruppi: il bot deve essere aggiunto come membro/admin.
// CORS: Telegram API ha CORS aperto per botAPI.

const TG_BASE = 'https://api.telegram.org'

/**
 * Verifica che il bot token sia valido.
 */
export async function getBotInfo(token) {
  const res = await fetch(`${TG_BASE}/bot${token}/getMe`)
  if (!res.ok) throw new Error(`Bot token invalido (HTTP ${res.status})`)
  const data = await res.json()
  if (!data.ok) throw new Error(data.description || 'Bot token invalido')
  return data.result
}

/**
 * Restituisce gli ultimi N messaggi da un canale tramite getUpdates.
 * NOTA: Telegram bot API non permette di leggere chat history arbitraria.
 * Solo messaggi inviati DOPO che il bot è stato aggiunto possono essere recuperati con getUpdates.
 *
 * Per chat history: l'utente deve usare un'altra API (Telegram Client API/MTProto) che richiede
 * autenticazione utente, non bot.
 */
export async function fetchRecentUpdates(token, limit = 100) {
  const res = await fetch(`${TG_BASE}/bot${token}/getUpdates?limit=${limit}&allowed_updates=["channel_post","message"]`)
  if (!res.ok) throw new Error(`Telegram HTTP ${res.status}`)
  const data = await res.json()
  if (!data.ok) throw new Error(data.description)
  // Estrae messaggi dai canali
  return data.result.map(u => {
    const msg = u.channel_post || u.message
    if (!msg) return null
    return {
      id:        u.update_id,
      messageId: msg.message_id,
      chatId:    msg.chat.id,
      chatTitle: msg.chat.title || msg.chat.username || 'unknown',
      chatUsername: msg.chat.username || null,
      type:      msg.chat.type,             // 'channel', 'group', 'supergroup', 'private'
      date:      new Date(msg.date * 1000),
      text:      msg.text || msg.caption || '',
      hasMedia:  !!(msg.photo || msg.video || msg.document),
    }
  }).filter(Boolean)
}

/**
 * Invia un messaggio di test al bot (per verifica funzionamento).
 */
export async function sendTestMessage(token, chatId, text) {
  const res = await fetch(`${TG_BASE}/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text }),
  })
  return res.ok
}

// Filtri/parsing tipici per messaggi di trading
const SIGNAL_PATTERNS = {
  buy:    /\b(buy|long|bullish|comprare|achat)\b/i,
  sell:   /\b(sell|short|bearish|vendere|vente)\b/i,
  pair:   /\b(XAU\/?USD|GOLD|EUR\/?USD|GBP\/?USD|USD\/?JPY|GBP\/?JPY|BTC\/?USD)\b/i,
  price:  /\b\d{1,5}\.\d{1,5}\b/g,
  sl:     /\b(SL|stop\s*loss)[:\s]*([\d.]+)/i,
  tp:     /\b(TP\d?|take\s*profit\d?)[:\s]*([\d.]+)/i,
}

export function parseSignalMessage(text) {
  if (!text) return null
  const buyMatch = SIGNAL_PATTERNS.buy.test(text)
  const sellMatch = SIGNAL_PATTERNS.sell.test(text)
  const pairMatch = SIGNAL_PATTERNS.pair.exec(text)
  if (!buyMatch && !sellMatch) return null
  const slMatch = SIGNAL_PATTERNS.sl.exec(text)
  const tpMatch = SIGNAL_PATTERNS.tp.exec(text)
  return {
    direction: buyMatch ? 'BUY' : 'SELL',
    pair:      pairMatch ? pairMatch[0].toUpperCase().replace(/\//, '') : null,
    sl:        slMatch ? parseFloat(slMatch[2]) : null,
    tp:        tpMatch ? parseFloat(tpMatch[2]) : null,
    raw:       text,
  }
}
