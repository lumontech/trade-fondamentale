"""Fix the CTRADER_FIX_PASSWORD in VPS .env that was truncated by shell $ interpolation.
Writes the password directly via SFTP, no shell command involved.
"""
import os, sys, io
import paramiko

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8', errors='replace')

REAL_PASSWORD = 'qZ2Y6sq#hjHJbPz'  # the user's actual cTrader password

c = paramiko.SSHClient()
c.set_missing_host_key_policy(paramiko.AutoAddPolicy())
c.connect("81.17.100.112", username="root", password=os.environ["VPS_PASSWORD"],
          timeout=15, look_for_keys=False, allow_agent=False)

REMOTE_ENV = "/root/impact-trading-server/.env"

# 1) Read current .env
sftp = c.open_sftp()
with sftp.open(REMOTE_ENV, 'r') as f:
    content = f.read().decode('utf-8')

# 2) Replace the CTRADER_FIX_PASSWORD line precisely
lines = content.splitlines()
new_lines = []
found = False
for line in lines:
    if line.startswith('CTRADER_FIX_PASSWORD='):
        # Use single quotes — dotenv preserves literal in single quotes
        new_lines.append(f"CTRADER_FIX_PASSWORD='{REAL_PASSWORD}'")
        found = True
    else:
        new_lines.append(line)
if not found:
    new_lines.append(f"CTRADER_FIX_PASSWORD='{REAL_PASSWORD}'")

new_content = '\n'.join(new_lines) + '\n'

# 3) Write back via SFTP (no shell involved)
with sftp.open(REMOTE_ENV, 'w') as f:
    f.write(new_content.encode('utf-8'))
sftp.chmod(REMOTE_ENV, 0o600)
sftp.close()

# 4) Verify by reading password length via node
def run(cmd):
    _, so, _ = c.exec_command(cmd)
    return so.read().decode('utf-8', errors='replace').rstrip()

print("Verifying password length via node:")
out = run("cd /root/impact-trading-server && node --env-file=.env -e \"const p=process.env.CTRADER_FIX_PASSWORD; console.log('FIX_PWD length =', p.length, '| starts/ends:', p[0], p.slice(-1), '| has $:', p.includes('\\$'), '| has @:', p.includes('@'))\"")
print(out)

# 5) Restart pm2 so new env is picked up
print()
print("Restarting pm2...")
out = run("pm2 restart impact-trading-server --update-env 2>&1 | tail -3")
print(out)

c.close()
