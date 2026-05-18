"""Deploy completo: frontend dist/ + nuovo server/src/macroProxy.js + index.js + restart pm2.

Sostituisce gli endpoint corsproxy.io con proxy backend (cache 15 min).
Lo script:
 1. Carica VPS_PASSWORD da env o .env
 2. SFTP-upload frontend/dist/* in /var/www/impact/
 3. SFTP-upload server/src/macroProxy.js + index.js in /root/impact-trading-server/src/
 4. PM2 restart impact-trading-server
 5. Verifica /api/macro/ff-calendar + /api/macro/fng

Idempotente: rilanciandolo aggiorna solo i file cambiati.
"""
import os, sys, io
from pathlib import Path
import paramiko

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8', errors='replace')

HOST = "81.17.100.112"
USER = "root"
PROJECT_ROOT = Path(__file__).resolve().parent.parent
LOCAL_DIST   = PROJECT_ROOT / "frontend" / "dist"
LOCAL_SERVER = PROJECT_ROOT / "server" / "src"

password = os.environ.get("VPS_PASSWORD")
if not password:
    env_path = PROJECT_ROOT / ".env"
    if env_path.exists():
        for line in env_path.read_text(encoding="utf-8", errors="replace").splitlines():
            if line.strip().startswith("VPS_PASSWORD="):
                password = line.split("=", 1)[1].strip().strip('"').strip("'")
                break
if not password:
    print("ERROR: VPS_PASSWORD not set", file=sys.stderr)
    sys.exit(1)

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

# 2) Server files
print("\n=== STEP 2: server source -> /root/impact-trading-server/src ===")
for fname in ("macroProxy.js", "index.js"):
    src  = LOCAL_SERVER / fname
    dest = f"/root/impact-trading-server/src/{fname}"
    print(f"[sftp] {fname} -> {dest}")
    sftp.put(str(src), dest)

sftp.close()

# 3) pm2 restart
print("\n=== STEP 3: pm2 restart impact-trading-server ===")
run("pm2 restart impact-trading-server --update-env 2>&1 | tail -3")

# 4) verify
import time
time.sleep(3)
print("\n=== STEP 4: verify endpoints ===")
run("curl -s http://localhost:3000/api/health")
print()
run('curl -s "http://localhost:3000/api/macro/fng" | head -c 200')
print()
run('curl -s "http://localhost:3000/api/macro/ff-calendar" | head -c 200')
print()
run('curl -s "http://localhost:3000/api/macro/fred/DGS10" | head -c 200')

c.close()
print("\n[deploy] DONE")
