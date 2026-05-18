"""
Full deploy: server (Node.js) + frontend (Vite dist) via SFTP, then restart pm2.

Password from VPS_PASSWORD env var.
"""
import os
import sys
import io
from pathlib import Path
import paramiko

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8', errors='replace')
sys.stderr = io.TextIOWrapper(sys.stderr.buffer, encoding='utf-8', errors='replace')

HOST = "81.17.100.112"
USER = "root"
LOCAL_DIST   = Path(r"C:\Users\Stefano\.claude\trade.fondamentale\frontend\dist")
LOCAL_SERVER = Path(r"C:\Users\Stefano\.claude\trade.fondamentale\server\src")
REMOTE_FRONTEND = "/var/www/impact"
REMOTE_SERVER   = "/root/impact-trading-server/src"
PM2_APP = "impact-trading-server"

password = os.environ.get("VPS_PASSWORD")
if not password:
    print("ERROR: VPS_PASSWORD env var not set", file=sys.stderr)
    sys.exit(1)

print(f"[deploy] Connecting to {USER}@{HOST} ...")
client = paramiko.SSHClient()
client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
try:
    client.connect(HOST, username=USER, password=password, timeout=15,
                   look_for_keys=False, allow_agent=False)
    print("[deploy] Connected OK")
except Exception as e:
    print(f"[deploy] CONNECT FAILED: {e}", file=sys.stderr)
    sys.exit(2)


def run(cmd, ignore_errors=False):
    print(f"[ssh] $ {cmd}")
    stdin, stdout, stderr = client.exec_command(cmd)
    out = stdout.read().decode("utf-8", errors="replace").strip()
    err = stderr.read().decode("utf-8", errors="replace").strip()
    rc = stdout.channel.recv_exit_status()
    if out:
        print(f"[ssh] stdout: {out}")
    if err and not ignore_errors:
        print(f"[ssh] stderr: {err}")
    return rc, out, err


# Verify pm2 process cwd matches REMOTE_SERVER
rc, out, _ = run("pm2 describe impact-trading-server 2>&1 | grep -E 'exec cwd' | head -1", ignore_errors=True)
print(f"[deploy] pm2 cwd line: {out!r}")
print(f"[deploy] Uploading server src to: {REMOTE_SERVER}")


sftp = client.open_sftp()


def sftp_mkdir_p(path):
    parts = path.strip("/").split("/")
    cur = ""
    for p in parts:
        cur = f"{cur}/{p}"
        try:
            sftp.stat(cur)
        except FileNotFoundError:
            sftp.mkdir(cur)


def upload_dir(local_dir: Path, remote_dir: str, only_extensions=None):
    sftp_mkdir_p(remote_dir)
    for entry in local_dir.iterdir():
        local_path = entry
        remote_path = f"{remote_dir}/{entry.name}"
        if entry.is_dir():
            upload_dir(entry, remote_path, only_extensions)
        else:
            if only_extensions and entry.suffix not in only_extensions:
                continue
            print(f"[sftp]  {entry.name}  ->  {remote_path}")
            sftp.put(str(local_path), remote_path)


# 1) Upload server src (.js files only — skip node_modules, etc.)
print(f"[deploy] === SERVER === Uploading {LOCAL_SERVER} to {REMOTE_SERVER}")
upload_dir(LOCAL_SERVER, REMOTE_SERVER, only_extensions={'.js'})

# 2) Upload frontend dist
print(f"[deploy] === FRONTEND === Uploading {LOCAL_DIST} to {REMOTE_FRONTEND}")
upload_dir(LOCAL_DIST, REMOTE_FRONTEND)

sftp.close()

# 3) Restart pm2 to pick up server changes
print("[deploy] Restarting pm2 app...")
rc, out, _ = run(f"pm2 list 2>&1 | grep -E '(impact|server)' | head -5", ignore_errors=True)
rc, _, _ = run(f"pm2 restart {PM2_APP} --update-env 2>&1 || pm2 restart all 2>&1 | head -20", ignore_errors=True)

# 4) Verify endpoint health
print("[deploy] Health check...")
run("sleep 2 && curl -s http://localhost:3000/api/health || echo 'health endpoint failed'", ignore_errors=True)
run("curl -s 'http://localhost:3000/api/yahoo/candles?symbol=XAUUSD&tf=1h&count=5' | head -c 300", ignore_errors=True)

client.close()
print("[deploy] DONE")
