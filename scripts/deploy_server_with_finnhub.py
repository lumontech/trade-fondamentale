"""
Deploy server + frontend, set FINNHUB_API_KEY in VPS .env, restart pm2.

Env vars:
  VPS_PASSWORD  - root SSH password
  FINNHUB_KEY   - Finnhub personal token (not logged)
"""
import os, sys, io
from pathlib import Path
import paramiko

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8', errors='replace')
sys.stderr = io.TextIOWrapper(sys.stderr.buffer, encoding='utf-8', errors='replace')

HOST = "81.17.100.112"
USER = "root"
LOCAL_SERVER = Path(r"C:\Users\Stefano\.claude\trade.fondamentale\server\src")
REMOTE_SERVER_ROOT = "/root/impact-trading-server"
REMOTE_SERVER_SRC  = f"{REMOTE_SERVER_ROOT}/src"
REMOTE_ENV         = f"{REMOTE_SERVER_ROOT}/.env"
PM2_APP = "impact-trading-server"

password = os.environ.get("VPS_PASSWORD")
finnhub_key = os.environ.get("FINNHUB_KEY")
if not password or not finnhub_key:
    print("ERROR: VPS_PASSWORD and FINNHUB_KEY env vars required", file=sys.stderr)
    sys.exit(1)

print(f"[deploy] Connecting to {USER}@{HOST}...")
client = paramiko.SSHClient()
client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
client.connect(HOST, username=USER, password=password, timeout=15,
               look_for_keys=False, allow_agent=False)
print("[deploy] Connected")

def run(cmd, ignore_errors=False, hide_cmd=False):
    if not hide_cmd:
        print(f"[ssh] $ {cmd}")
    _, stdout, stderr = client.exec_command(cmd)
    out = stdout.read().decode(errors="replace").strip()
    err = stderr.read().decode(errors="replace").strip()
    rc = stdout.channel.recv_exit_status()
    if out and not hide_cmd: print(f"[ssh] {out}")
    if err and not ignore_errors and not hide_cmd: print(f"[ssh] err: {err}")
    return rc, out, err

# 1) Upload server src (.js files)
sftp = client.open_sftp()
for entry in LOCAL_SERVER.iterdir():
    if entry.suffix != '.js': continue
    remote = f"{REMOTE_SERVER_SRC}/{entry.name}"
    print(f"[sftp] {entry.name} -> {remote}")
    sftp.put(str(entry), remote)
sftp.close()

# 2) Update FINNHUB_API_KEY in .env (idempotent: replace existing or append)
# Use a sentinel to avoid logging the actual key.
print("[deploy] Setting FINNHUB_API_KEY in .env (key not logged)")
script = (
    f"f={REMOTE_ENV}; "
    f"touch $f; chmod 600 $f; "
    f"grep -q '^FINNHUB_API_KEY=' $f && "
    f"sed -i 's|^FINNHUB_API_KEY=.*|FINNHUB_API_KEY={finnhub_key}|' $f || "
    f"echo 'FINNHUB_API_KEY={finnhub_key}' >> $f"
)
run(script, hide_cmd=True)
# Verify (echo only that the key is set, not the value)
run(f"grep -c '^FINNHUB_API_KEY=' {REMOTE_ENV} && echo 'FINNHUB_API_KEY present in .env'")

# 3) Restart pm2 with --update-env to pick up new env var
run(f"pm2 restart {PM2_APP} --update-env")

# 4) Verify endpoint still healthy + sim picks up new code
run("sleep 2 && curl -s http://localhost:3000/api/health")
run("pm2 logs impact-trading-server --lines 15 --nostream 2>&1 | tail -20")

client.close()
print("[deploy] DONE")
