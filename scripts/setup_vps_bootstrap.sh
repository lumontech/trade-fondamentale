#!/usr/bin/env bash
# setup_vps_bootstrap.sh
# Bootstrap completo del VPS Impact Trading dopo reinstall pulito Ubuntu 22.04.
#
# COSA FA:
#   1. apt update + installa Node.js 20, pm2, Caddy, sqlite3, git, build-essentials
#   2. Clona il repo da GitHub in /root/impact-trading
#   3. npm install nel server
#   4. Build del frontend (necessita Node + npm già installati)
#   5. Crea /etc/impact/.env (interattivo, chiede 2 API key) con API_KEYS_SECRET auto-generato
#   6. Copia frontend dist → /var/www/impact/
#   7. Avvia backend Hono con pm2 (auto-start on reboot)
#   8. Configura Caddy reverse proxy con TLS automatica
#   9. Health check finale
#
# USO (sul VPS appena reinstallato, già loggato come root):
#   curl -s https://raw.githubusercontent.com/lumontech/trade-fondamentale/main/scripts/setup_vps_bootstrap.sh | bash
#
# Oppure (preferito, perché vedi i log progressivamente):
#   git clone https://github.com/lumontech/trade-fondamentale /root/impact-trading
#   cd /root/impact-trading
#   bash scripts/setup_vps_bootstrap.sh
#
# IDEMPOTENTE: rilanciandolo aggiorna solo le parti necessarie.

set -e   # exit on error
set -u   # error on undefined var
set -o pipefail

# ── Helper di output ────────────────────────────────────────────────
RED=$'\033[0;31m'; GRN=$'\033[0;32m'; YLW=$'\033[1;33m'; CYN=$'\033[0;36m'; RST=$'\033[0m'
ok()   { echo "${GRN}[ok]${RST} $1"; }
info() { echo "${CYN}[..]${RST} $1"; }
warn() { echo "${YLW}[!!]${RST} $1"; }
err()  { echo "${RED}[ERR]${RST} $1" >&2; }
hr()   { echo ""; echo "${CYN}==== $1 ====${RST}"; echo ""; }

# Deve essere root
if [ "$EUID" -ne 0 ]; then
  err "Esegui come root: sudo bash $0"
  exit 1
fi

REPO_URL="https://github.com/lumontech/trade-fondamentale.git"
PROJECT_DIR="/root/impact-trading"
ENV_DIR="/etc/impact"
ENV_FILE="${ENV_DIR}/.env"
WEB_ROOT="/var/www/impact"
DOMAIN="impact-81-17-100-112.nip.io"

# ── STEP 1: pacchetti base ─────────────────────────────────────────
hr "STEP 1: aggiornamento sistema e pacchetti base"

export DEBIAN_FRONTEND=noninteractive

info "apt update..."
apt-get update -qq

info "installo pacchetti base (curl, git, sqlite3, ufw, etc.)..."
apt-get install -y -qq \
  curl wget git ca-certificates gnupg lsb-release \
  sqlite3 build-essential \
  ufw fail2ban htop

ok "pacchetti base installati"

# ── STEP 2: Node.js 20 (NodeSource) ────────────────────────────────
hr "STEP 2: Node.js 20 LTS"

if command -v node >/dev/null && node -v | grep -qE '^v(2[0-9])'; then
  ok "Node $(node -v) già presente"
else
  info "scarico NodeSource setup per Node 20.x..."
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
  apt-get install -y -qq nodejs
  ok "installato Node $(node -v) / npm $(npm -v)"
fi

# ── STEP 3: pm2 globale ────────────────────────────────────────────
hr "STEP 3: PM2 process manager"

if command -v pm2 >/dev/null; then
  ok "pm2 $(pm2 -v) già presente"
else
  info "installo pm2 globale..."
  npm install -g pm2 >/dev/null 2>&1
  ok "pm2 $(pm2 -v) installato"
fi

# ── STEP 4: Caddy (per HTTPS automatico + reverse proxy) ───────────
hr "STEP 4: Caddy server"

if command -v caddy >/dev/null; then
  ok "Caddy $(caddy version | head -1) già presente"
else
  info "aggiungo repo Caddy ufficiale..."
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' > /etc/apt/sources.list.d/caddy-stable.list
  apt-get update -qq
  apt-get install -y -qq caddy
  ok "Caddy installato"
fi

# ── STEP 5: clone repo ─────────────────────────────────────────────
hr "STEP 5: clone repository"

if [ -d "${PROJECT_DIR}/.git" ]; then
  info "repo già clonato, faccio pull..."
  cd "${PROJECT_DIR}"
  git pull --rebase
  ok "repo aggiornato"
else
  info "clono ${REPO_URL} in ${PROJECT_DIR}..."
  git clone --depth 1 "${REPO_URL}" "${PROJECT_DIR}"
  ok "repo clonato"
fi

cd "${PROJECT_DIR}"

# ── STEP 6: install dependencies server ────────────────────────────
hr "STEP 6: install dependencies backend"

cd "${PROJECT_DIR}/server"
info "npm install in server/..."
npm install --production --no-audit --no-fund 2>&1 | tail -5
ok "server deps installate"

# ── STEP 7: install + build frontend ───────────────────────────────
hr "STEP 7: build frontend"

cd "${PROJECT_DIR}/frontend"
info "npm install in frontend/..."
npm install --no-audit --no-fund 2>&1 | tail -5
info "npm run build..."
npm run build 2>&1 | tail -10

if [ ! -f "dist/index.html" ]; then
  err "build frontend fallita: dist/index.html non trovato"
  exit 1
fi
ok "frontend buildato in dist/"

# ── STEP 8: pubblica frontend in /var/www/impact ───────────────────
hr "STEP 8: deploy frontend in ${WEB_ROOT}"

mkdir -p "${WEB_ROOT}"
rm -rf "${WEB_ROOT:?}"/*    # safe rm grazie a ${:?}
cp -r "${PROJECT_DIR}/frontend/dist/"* "${WEB_ROOT}/"
chown -R caddy:caddy "${WEB_ROOT}" 2>/dev/null || true
ok "frontend pubblicato in ${WEB_ROOT}"

# ── STEP 9: setup .env server (interattivo) ────────────────────────
hr "STEP 9: configurazione .env server"

mkdir -p "${ENV_DIR}"
chmod 700 "${ENV_DIR}"

if [ -f "${ENV_FILE}" ]; then
  ok ".env esistente trovato in ${ENV_FILE}, lo riuso"
  info "contenuto (chiavi nascoste):"
  awk -F= '/^[A-Z_]+=/{print $1"=***"}' "${ENV_FILE}"
else
  info "genero API_KEYS_SECRET casuale (per encryption AES delle user api-keys)..."
  API_KEYS_SECRET=$(openssl rand -hex 32)

  echo ""
  warn "Servono 2 API key per il funzionamento completo:"
  warn "  - FRED_API_KEY      (https://fredaccount.stlouisfed.org/apikey)"
  warn "  - ANTHROPIC_API_KEY (opzionale lato server, di solito sta nel browser)"
  echo ""
  # Se FRED_KEY è già nell'ambiente (es. setup non interattivo via SSH),
  # saltiamo il prompt. Altrimenti chiediamo all'utente.
  if [ -z "${FRED_KEY:-}" ]; then
    read -p "FRED_API_KEY [premi invio per skip]: " FRED_KEY
  else
    info "FRED_KEY ricevuta da environment, salto prompt interattivo"
  fi
  FRED_KEY="${FRED_KEY:-}"

  cat > "${ENV_FILE}" <<EOF
# Impact Trading Server - generated by setup_vps_bootstrap.sh
NODE_ENV=production
PORT=3000

# Encryption at-rest delle user API keys (NON cambiare dopo il primo uso)
API_KEYS_SECRET=${API_KEYS_SECRET}

# Macro proxy FRED (yields, VIX, DXY)
FRED_API_KEY=${FRED_KEY}

# CORS allowed origins
ALLOWED_ORIGINS=https://${DOMAIN}

# Auth session
SESSION_TTL_HOURS=720
EOF

  chmod 600 "${ENV_FILE}"
  ok ".env creato in ${ENV_FILE}"
fi

# Symlink dal project dir al config (così il server legge ${PROJECT_DIR}/server/.env)
ln -sf "${ENV_FILE}" "${PROJECT_DIR}/server/.env"
ok "symlink ${PROJECT_DIR}/server/.env -> ${ENV_FILE}"

# ── STEP 10: init DB se non esiste ─────────────────────────────────
hr "STEP 10: init database SQLite"

mkdir -p "${PROJECT_DIR}/server/data"
DB_FILE="${PROJECT_DIR}/server/data/impact.db"
if [ ! -f "${DB_FILE}" ]; then
  touch "${DB_FILE}"
  ok "DB SQLite vuoto creato in ${DB_FILE} (sarà popolato al primo start dalle migrations)"
else
  ok "DB esistente trovato"
fi

# ── STEP 11: pm2 start del backend ─────────────────────────────────
hr "STEP 11: avvio backend con pm2"

cd "${PROJECT_DIR}/server"

# Se l'app già esiste in pm2, restart con --update-env, altrimenti start fresh
if pm2 describe impact-trading-server >/dev/null 2>&1; then
  info "pm2 restart impact-trading-server..."
  pm2 restart impact-trading-server --update-env
else
  info "pm2 start nuovo processo..."
  pm2 start "node src/index.js" --name impact-trading-server --time
fi

pm2 save >/dev/null
ok "backend in esecuzione"

# Setup pm2 startup (auto-restart al reboot)
if [ ! -f /etc/systemd/system/pm2-root.service ]; then
  info "configuro pm2 startup (autostart al reboot)..."
  pm2 startup systemd -u root --hp /root 2>&1 | grep -E "^sudo" | bash || true
  ok "pm2 autostart configurato"
fi

# ── STEP 12: Caddy reverse proxy + TLS auto ────────────────────────
hr "STEP 12: configurazione Caddy"

CADDYFILE="/etc/caddy/Caddyfile"
cat > "${CADDYFILE}" <<EOF
# Impact Trading Platform - generated by setup_vps_bootstrap.sh
${DOMAIN} {
    # Static frontend
    root * ${WEB_ROOT}

    # API → backend Hono su porta 3000
    handle /api/* {
        reverse_proxy localhost:3000
    }

    # WebSocket per eventuali subscribe
    @websocket {
        header Connection *Upgrade*
        header Upgrade websocket
    }
    handle @websocket {
        reverse_proxy localhost:3000
    }

    # SPA fallback: tutte le route non-/api ritornano index.html
    handle {
        try_files {path} /index.html
        file_server
    }

    encode gzip zstd
    log {
        output file /var/log/caddy/impact.log {
            roll_size 50mb
            roll_keep 10
        }
    }
}
EOF

ok "Caddyfile scritto in ${CADDYFILE}"

# Format + validate
caddy fmt --overwrite "${CADDYFILE}" >/dev/null 2>&1 || true

# Reload Caddy
systemctl enable --now caddy >/dev/null 2>&1
systemctl reload caddy
ok "Caddy ricaricato (TLS verrà richiesto a Let's Encrypt al primo accesso)"

# ── STEP 13: firewall base ─────────────────────────────────────────
hr "STEP 13: firewall (ufw)"

if ! ufw status | grep -q "Status: active"; then
  info "configuro UFW: SSH(22) + HTTP(80) + HTTPS(443)..."
  ufw default deny incoming >/dev/null
  ufw default allow outgoing >/dev/null
  ufw allow 22/tcp >/dev/null
  ufw allow 80/tcp >/dev/null
  ufw allow 443/tcp >/dev/null
  ufw --force enable >/dev/null
  ok "UFW attivo: 22, 80, 443 aperti"
else
  ok "UFW già attivo"
fi

# ── STEP 14: health check ──────────────────────────────────────────
hr "STEP 14: verifica health"

sleep 3
info "test backend localhost:3000/api/health..."
HEALTH=$(curl -s -m 5 http://localhost:3000/api/health || echo "FAIL")
echo "  $HEALTH"

info "test frontend tramite Caddy (https://${DOMAIN})..."
sleep 2
FRONTEND=$(curl -s -k -m 10 -o /dev/null -w "HTTP %{http_code}" "https://${DOMAIN}/" || echo "FAIL")
echo "  $FRONTEND"

# ── DONE ───────────────────────────────────────────────────────────
hr "✓ BOOTSTRAP COMPLETATO"

cat <<EOF

Status:
  Backend:    pm2 list  (impact-trading-server)
  Frontend:   ${WEB_ROOT}/  (servito da Caddy su https://${DOMAIN})
  DB SQLite:  ${DB_FILE}
  Env:        ${ENV_FILE}  (chmod 600)
  Logs:       pm2 logs impact-trading-server
              tail -f /var/log/caddy/impact.log

Prossimi step possibili:
  - Aggiorna FRED_API_KEY se non l'hai inserita: nano ${ENV_FILE} && pm2 restart impact-trading-server
  - Per redeploy dopo push su GitHub: cd ${PROJECT_DIR} && git pull && bash scripts/setup_vps_bootstrap.sh

EOF
