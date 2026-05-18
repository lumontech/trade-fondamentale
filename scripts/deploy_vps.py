"""
Deploy frontend dist/ to VPS via SFTP using root password (one-shot).
Password is read from VPS_PASSWORD env var — never stored on disk.

SCOPE: Only SFTP-uploads the frontend build to /var/www/impact/.
       No persistent credential changes, no service modifications.
"""
import os
import sys
from pathlib import Path
import paramiko

HOST = "81.17.100.112"
USER = "root"
LOCAL_DIST = Path(r"C:\Users\Stefano\.claude\trade.fondamentale\frontend\dist")
REMOTE_DEST = "/var/www/impact"

password = os.environ.get("VPS_PASSWORD")
if not password:
    # Fallback: leggi VPS_PASSWORD da .env nella root del progetto
    env_path = Path(__file__).resolve().parent.parent / ".env"
    if env_path.exists():
        for line in env_path.read_text(encoding="utf-8", errors="replace").splitlines():
            line = line.strip()
            if line.startswith("VPS_PASSWORD="):
                password = line.split("=", 1)[1].strip().strip('"').strip("'")
                break
if not password:
    print("ERROR: VPS_PASSWORD not set (env var or .env file)", file=sys.stderr)
    sys.exit(1)

import io
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8', errors='replace')
sys.stderr = io.TextIOWrapper(sys.stderr.buffer, encoding='utf-8', errors='replace')
print(f"[deploy] Connecting to {USER}@{HOST} ...")
client = paramiko.SSHClient()
client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
try:
    client.connect(HOST, username=USER, password=password, timeout=15, look_for_keys=False, allow_agent=False)
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

# 1. Verify destination exists
run(f"ls -la {REMOTE_DEST}/ | head -20")

# 2. SFTP upload dist/ contents recursively (no SSH key changes, no service touch)
print(f"[deploy] Opening SFTP → {REMOTE_DEST}/")
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

def upload_dir(local_dir: Path, remote_dir: str):
    sftp_mkdir_p(remote_dir)
    for entry in local_dir.iterdir():
        local_path = entry
        remote_path = f"{remote_dir}/{entry.name}"
        if entry.is_dir():
            upload_dir(entry, remote_path)
        else:
            print(f"[sftp]  {entry.name}  →  {remote_path}")
            sftp.put(str(local_path), remote_path)

if not LOCAL_DIST.exists():
    print(f"[deploy] ERROR: local dist/ not found: {LOCAL_DIST}", file=sys.stderr)
    sys.exit(3)

upload_dir(LOCAL_DIST, REMOTE_DEST)
sftp.close()

# 3. Final verification (read-only)
run(f"ls -la {REMOTE_DEST}/")
run(f"ls {REMOTE_DEST}/assets/")

client.close()
print("[deploy] DONE ✔")
