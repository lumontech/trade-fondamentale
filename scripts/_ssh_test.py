"""One-shot: verifica se la password VPS funziona via SSH. Zero side-effects.
Legge VPS_PASSWORD da env o .env. Stampa OK/FAIL e basta."""
import os, sys, io
from pathlib import Path
import paramiko

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8', errors='replace')

HOST = "81.17.100.112"
USER = "root"

password = os.environ.get("VPS_PASSWORD")
if not password:
    env_path = Path(__file__).resolve().parent.parent / ".env"
    if env_path.exists():
        for line in env_path.read_text(encoding="utf-8", errors="replace").splitlines():
            if line.strip().startswith("VPS_PASSWORD="):
                password = line.split("=", 1)[1].strip().strip('"').strip("'")
                break

if not password:
    print("FAIL: VPS_PASSWORD non impostata (env var o .env)")
    sys.exit(1)

print(f"Testing SSH auth root@{HOST} (password len={len(password)})...")
c = paramiko.SSHClient()
c.set_missing_host_key_policy(paramiko.AutoAddPolicy())
try:
    c.connect(HOST, username=USER, password=password, timeout=10,
              look_for_keys=False, allow_agent=False)
    _, so, _ = c.exec_command("whoami && hostname")
    out = so.read().decode().strip()
    print(f"OK -> {out}")
    c.close()
    sys.exit(0)
except paramiko.AuthenticationException:
    print("FAIL: Authentication failed (password sbagliata)")
    sys.exit(2)
except Exception as e:
    print(f"FAIL: {type(e).__name__}: {e}")
    sys.exit(3)
