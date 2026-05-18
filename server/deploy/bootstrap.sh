#!/usr/bin/env bash
# Bootstrap script per VPS Contabo Ubuntu 22.04 fresh
# Esegui come root o con sudo: bash bootstrap.sh
set -euo pipefail

APP_USER="impact"
APP_DIR="/home/$APP_USER/impact-trading-server"
NODE_VERSION="20"

echo "→ Update sistema..."
apt-get update -y
apt-get upgrade -y
apt-get install -y curl git build-essential ufw

echo "→ Setup utente $APP_USER..."
if ! id -u "$APP_USER" >/dev/null 2>&1; then
  adduser --disabled-password --gecos "" "$APP_USER"
  usermod -aG sudo "$APP_USER"
fi

echo "→ Install Node.js $NODE_VERSION (NodeSource)..."
if ! command -v node >/dev/null 2>&1; then
  curl -fsSL "https://deb.nodesource.com/setup_${NODE_VERSION}.x" | bash -
  apt-get install -y nodejs
fi
node --version
npm --version

echo "→ Install PM2 globally..."
npm install -g pm2

echo "→ Install Caddy (reverse proxy + auto HTTPS)..."
if ! command -v caddy >/dev/null 2>&1; then
  apt-get install -y debian-keyring debian-archive-keyring apt-transport-https
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | tee /etc/apt/trusted.gpg.d/caddy-stable.asc
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | tee /etc/apt/sources.list.d/caddy-stable.list
  apt-get update -y
  apt-get install -y caddy
fi

echo "→ Firewall UFW..."
ufw default deny incoming
ufw default allow outgoing
ufw allow OpenSSH
ufw allow 80/tcp
ufw allow 443/tcp
ufw --force enable

echo "→ Crea cartella app + permessi..."
mkdir -p "$APP_DIR"
chown -R "$APP_USER:$APP_USER" "/home/$APP_USER"

echo "→ PM2 startup script per $APP_USER..."
sudo -u "$APP_USER" -H bash -c "pm2 startup systemd -u $APP_USER --hp /home/$APP_USER" || true
# Output di sopra contiene un comando da eseguire come root, esempio:
# env PATH=$PATH:/usr/bin /usr/lib/node_modules/pm2/bin/pm2 startup systemd -u impact --hp /home/impact

echo ""
echo "═══════════════════════════════════════════════════════"
echo "✅ Bootstrap completato"
echo ""
echo "Prossimi step:"
echo "  1. Copia il codice del server in $APP_DIR"
echo "     (es. con rsync o git clone)"
echo "  2. cd $APP_DIR"
echo "  3. cp .env.example .env  → modifica le keys"
echo "  4. npm ci --production"
echo "  5. node src/db.js --init"
echo "  6. pm2 start ecosystem.config.cjs"
echo "  7. pm2 save"
echo "  8. (opzionale) Caddy: sudo cp deploy/Caddyfile /etc/caddy/Caddyfile && sudo systemctl reload caddy"
echo "═══════════════════════════════════════════════════════"
