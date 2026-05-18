"""Deploy completo: API keys per-utente con encryption AES-256-GCM.

Esegue in sequenza:
 1. Frontend dist -> /var/www/impact
 2. Server: index.js, userApiKeys.js, migrations/0006_user_api_keys.sql
 3. Genera API_KEYS_SECRET (64 hex chars) e lo aggiunge al .env se mancante
 4. pm2 restart (migration 0006 viene applicata automaticamente dal db.js)
 5. Verifica /api/user/api-keys/status

Idempotente: se API_KEYS_SECRET esiste già non lo sovrascrive (importante! cambiare
il secret invalida le key cifrate e l'utente deve reinserirle).
"""
import os, sys, io, secrets
from pathlib import Path
import paramiko

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8', errors='replace')

HOST = "81.17.100.112"
USER = "root"
PROJECT_ROOT = Path(__file__).resolve().parent.parent
LOCAL_DIST   = PROJECT_ROOT / "frontend" / "dist"
LOCAL_SERVER = PROJECT_ROOT / "server"

password = os.environ.get("VPS_PASSWORD")
if not password:
    env_path = PROJECT_ROOT / ".env"
    if env_path.exists():
        for line in env_path.read_text(encoding="utf-8", errors="replace").splitlines():
            if line.strip().startswith("VPS_PASSWORD="):
                password = line.split("=", 1)[1].strip().strip('"').strip("'")
                break
if not password:
    print("ERROR: VPS_PASSWORD not set", file=sys.stderr); sys.exit(1)

print(f"[deploy] connecting to {USER}@{HOST}")
c = paramiko.SSHClient()
c.set_missing_host_key_policy(paramiko.AutoAddPolicy())
c.connect(HOST, username=USER, password=password, timeout=15,
          look_for_keys=False, allow_agent=False)
print("[deploy] connected")

def run(cmd):
    print(f"[ssh] $ {cmd[:140]}")
    _, so, _ = c.exec_command(cmd)
    out = so.read().decode("utf-8", errors="replace").rstrip()
    if out: print(out)
    return out

sftp = c.open_sftp()
def sftp_mkdir_p(path):
    parts = path.strip("/").split("/")
    cur = ""
    for p in parts:
        cur = f"{cur}/{p}"
        try: sftp.stat(cur)
        except FileNotFoundError: sftp.mkdir(cur)
def upload_dir(local: Path, remote: str):
    sftp_mkdir_p(remote)
    for entry in local.iterdir():
        rp = f"{remote}/{entry.name}"
        if entry.is_dir(): upload_dir(entry, rp)
        else:
            print(f"[sftp] {entry.name} -> {rp}")
            sftp.put(str(entry), rp)

# 1) Frontend
print("\n=== STEP 1: frontend dist -> /var/www/impact ===")
upload_dir(LOCAL_DIST, "/var/www/impact")

# 2) Server source files + migration
print("\n=== STEP 2: server source + migration ===")
for fname in ("index.js", "userApiKeys.js"):
    src  = LOCAL_SERVER / "src" / fname
    dest = f"/root/impact-trading-server/src/{fname}"
    print(f"[sftp] {fname} -> {dest}")
    sftp.put(str(src), dest)
# Migration
mig_src  = LOCAL_SERVER / "migrations" / "0006_user_api_keys.sql"
mig_dest = "/root/impact-trading-server/migrations/0006_user_api_keys.sql"
print(f"[sftp] 0006_user_api_keys.sql -> {mig_dest}")
sftp.put(str(mig_src), mig_dest)

sftp.close()

# 3) Genera API_KEYS_SECRET se non già presente
print("\n=== STEP 3: API_KEYS_SECRET nel .env del server ===")
existing = run("grep '^API_KEYS_SECRET=' /root/impact-trading-server/.env 2>/dev/null || true")
if existing.strip():
    print("[ok] API_KEYS_SECRET già presente nel .env — NON sovrascrivo")
    print("     (cambiarlo invaliderebbe tutte le chiavi cifrate esistenti)")
else:
    new_secret = secrets.token_hex(32)   # 64 hex chars = 32 byte
    print(f"[ok] genero nuovo API_KEYS_SECRET (64 hex chars)")
    # Append in maniera sicura (no inline interpolation in shell, uso heredoc base64)
    import base64
    b64_line = base64.b64encode(f"API_KEYS_SECRET={new_secret}\n".encode()).decode()
    run(f"echo '{b64_line}' | base64 -d >> /root/impact-trading-server/.env")
    run("grep '^API_KEYS_SECRET=' /root/impact-trading-server/.env | head -c 40 ; echo '...(troncato)'")

# 4) pm2 restart (con --update-env per ricaricare API_KEYS_SECRET)
print("\n=== STEP 4: pm2 restart impact-trading-server ===")
run("pm2 restart impact-trading-server --update-env 2>&1 | tail -3")

# 5) Verifica
import time
time.sleep(3)
print("\n=== STEP 5: verifica endpoint ===")
run("curl -s http://localhost:3000/api/health")
print()
# /status NON è whitelistato — restituisce 401 senza session, e va bene così.
# Verifichiamo invece i log per assicurarci che la migration 0006 sia stata applicata.
run("pm2 logs impact-trading-server --lines 20 --nostream 2>&1 | grep -E '0006|migration|applied' | tail -5")

c.close()
print("\n[deploy] DONE")
print("Ora dal browser: logout + login, e nel localStorage del browser troverai le tue key recuperate dal server.")
