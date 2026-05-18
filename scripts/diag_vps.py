"""Find where pm2 is actually running server from, and where REST routes are."""
import os, sys, io
import paramiko
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8', errors='replace')

client = paramiko.SSHClient()
client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
client.connect("81.17.100.112", username="root", password=os.environ["VPS_PASSWORD"],
               timeout=15, look_for_keys=False, allow_agent=False)

def run(cmd):
    _, stdout, stderr = client.exec_command(cmd)
    out = stdout.read().decode(errors="replace")
    err = stderr.read().decode(errors="replace")
    if out: print(out.rstrip())
    if err: print("STDERR:", err.rstrip())

print("=== pm2 process details ===")
run("pm2 describe impact-trading-server 2>&1 | head -40")
print()
print("=== auth middleware ===")
run("find / -name 'auth.js' -path '*/server/*' 2>/dev/null")
client.close()
