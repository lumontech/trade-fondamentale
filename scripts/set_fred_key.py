"""One-shot: aggiunge FRED_API_KEY al .env del server VPS e fa pm2 restart.

Idempotente: se la riga esiste già la aggiorna, altrimenti la appende.
"""
import os, sys, io
from pathlib import Path
import paramiko

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8', errors='replace')

HOST = "81.17.100.112"
USER = "root"
FRED_KEY = "7bcd5e50f9f5686297bd55a23b7765d1"
ENV_FILE = "/root/impact-trading-server/.env"

password = os.environ.get("VPS_PASSWORD")
if not password:
    env_path = Path(__file__).resolve().parent.parent / ".env"
    if env_path.exists():
        for line in env_path.read_text(encoding="utf-8", errors="replace").splitlines():
            if line.strip().startswith("VPS_PASSWORD="):
                password = line.split("=", 1)[1].strip().strip('"').strip("'")
                break
if not password:
    print("ERROR: VPS_PASSWORD not set", file=sys.stderr); sys.exit(1)

c = paramiko.SSHClient()
c.set_missing_host_key_policy(paramiko.AutoAddPolicy())
c.connect(HOST, username=USER, password=password, timeout=15,
          look_for_keys=False, allow_agent=False)

def run(cmd):
    print(f"[ssh] $ {cmd[:140]}")
    _, so, _ = c.exec_command(cmd)
    out = so.read().decode("utf-8", errors="replace").rstrip()
    if out: print(out)
    return out

# Sed idempotente: rimuove eventuale riga FRED_API_KEY esistente, poi appende quella nuova
run(f"sed -i '/^FRED_API_KEY=/d' {ENV_FILE} 2>/dev/null || true")
run(f"echo 'FRED_API_KEY={FRED_KEY}' >> {ENV_FILE}")
run(f"grep '^FRED_API_KEY' {ENV_FILE}")

run("pm2 restart impact-trading-server --update-env 2>&1 | tail -3")

import time; time.sleep(3)
run('curl -s "http://localhost:3000/api/macro/fred/DGS10" | head -c 250')

c.close()
print("\n[done]")
