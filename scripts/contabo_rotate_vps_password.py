"""Rotate la root password del VPS Contabo via API OAuth2.

PREREQUISITI: aggiungere al file .env del progetto le seguenti righe:
    CONTABO_CLIENT_ID=INT-xxxxxxxx
    CONTABO_CLIENT_SECRET=...
    CONTABO_USERNAME=email_account@contabo
    CONTABO_PASSWORD=password_account_contabo
    CONTABO_INSTANCE_ID=12345678        # numerico, lo trovi nel pannello

Lo script:
 1. Ottiene access_token via OAuth2 password grant
 2. Genera password casuale 24 char (no escape chars, alphanumerico + simboli safe)
 3. Crea un Contabo "secret" di tipo password
 4. Triggera reset password sull'instance (POST /v1/compute/instances/{id}/actions/reset-password)
 5. Aspetta ~90s la propagazione SSH
 6. Aggiorna VPS_PASSWORD nel .env del progetto

Idempotente sulla parte secret (ne crea uno nuovo ogni volta — vecchi possono essere puliti dal pannello).
"""
import os, sys, io, time, json, secrets as pysecrets, string, re, uuid
from pathlib import Path
import urllib.request, urllib.parse, urllib.error

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8', errors='replace')

PROJECT_ROOT = Path(__file__).resolve().parent.parent
ENV_FILE = PROJECT_ROOT / ".env"
OAUTH_URL = "https://auth.contabo.com/auth/realms/contabo/protocol/openid-connect/token"
API_BASE  = "https://api.contabo.com"

# ── Helper: lettura .env ───────────────────────────────────────────
def load_env():
    out = {}
    if not ENV_FILE.exists(): return out
    for line in ENV_FILE.read_text(encoding="utf-8", errors="replace").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line: continue
        k, v = line.split("=", 1)
        out[k.strip()] = v.strip().strip('"').strip("'")
    return out

def update_env_var(key, value):
    """Aggiorna o aggiunge una riga `key=value` nel .env. Idempotente."""
    lines = []
    if ENV_FILE.exists():
        lines = ENV_FILE.read_text(encoding="utf-8", errors="replace").splitlines()
    found = False
    new_lines = []
    for line in lines:
        if re.match(rf"^\s*{re.escape(key)}\s*=", line):
            new_lines.append(f"{key}={value}")
            found = True
        else:
            new_lines.append(line)
    if not found:
        new_lines.append(f"{key}={value}")
    ENV_FILE.write_text("\n".join(new_lines) + "\n", encoding="utf-8")

# ── HTTP helpers ───────────────────────────────────────────────────
def http_request(method, url, *, headers=None, body=None, is_json=True):
    data = None
    h = dict(headers or {})
    if body is not None:
        if is_json:
            data = json.dumps(body).encode()
            h.setdefault("Content-Type", "application/json")
        else:
            data = urllib.parse.urlencode(body).encode()
            h.setdefault("Content-Type", "application/x-www-form-urlencoded")
    req = urllib.request.Request(url, data=data, headers=h, method=method)
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            return r.status, json.loads(r.read().decode())
    except urllib.error.HTTPError as e:
        body = e.read().decode(errors="replace")
        try: parsed = json.loads(body)
        except: parsed = {"raw": body}
        return e.code, parsed

# ── Step 1: OAuth ──────────────────────────────────────────────────
def get_access_token(env):
    print("[1] obtaining OAuth access_token...")
    code, data = http_request("POST", OAUTH_URL, body={
        "grant_type": "password",
        "client_id":  env["CONTABO_CLIENT_ID"],
        "client_secret": env["CONTABO_CLIENT_SECRET"],
        "username":   env["CONTABO_USERNAME"],
        "password":   env["CONTABO_PASSWORD"],
    }, is_json=False)
    if code != 200 or "access_token" not in data:
        print(f"[ERROR] OAuth failed (HTTP {code}): {data}", file=sys.stderr)
        sys.exit(2)
    print(f"[ok] token obtained (expires in {data.get('expires_in','?')}s)")
    return data["access_token"]

# ── Step 2: random password ────────────────────────────────────────
def generate_password(length=24):
    # Solo char "shell-safe": no ^ \` & \ ' " $ # ! ; | ?
    alphabet = string.ascii_letters + string.digits + "@-_=+:.,*~"
    while True:
        pw = "".join(pysecrets.choice(alphabet) for _ in range(length))
        # Garanzia di mix: almeno 1 lower, 1 upper, 1 digit, 1 special
        if (any(c.islower() for c in pw) and any(c.isupper() for c in pw)
            and any(c.isdigit() for c in pw) and any(not c.isalnum() for c in pw)):
            return pw

# ── Step 3: create secret ──────────────────────────────────────────
def create_password_secret(token, name, password):
    print(f"[3] creating Contabo secret '{name}'...")
    code, data = http_request("POST", f"{API_BASE}/v1/secrets",
        headers={
            "Authorization": f"Bearer {token}",
            "x-request-id":  str(uuid.uuid4()),
        },
        body={"name": name, "type": "password", "value": password})
    if code not in (200, 201):
        print(f"[ERROR] secret creation failed (HTTP {code}): {data}", file=sys.stderr)
        sys.exit(3)
    secret_id = data.get("data", [{}])[0].get("secretId") or data.get("secretId")
    if not secret_id:
        print(f"[ERROR] no secretId in response: {data}", file=sys.stderr); sys.exit(3)
    print(f"[ok] secret created (id: {secret_id})")
    return secret_id

# ── Step 4: reset password sull'instance ───────────────────────────
def reset_instance_password(token, instance_id, secret_id):
    """Usa l'action endpoint ufficiale Contabo:
       POST /v1/compute/instances/{instanceId}/actions/resetPassword
       Body: { "rootPassword": <secretId integer> }
       Esegue il reset password SENZA reinstallare il SO (non distruttivo)."""
    print(f"[4] resetting root password on instance {instance_id}...")
    code, data = http_request("POST",
        f"{API_BASE}/v1/compute/instances/{instance_id}/actions/resetPassword",
        headers={
            "Authorization": f"Bearer {token}",
            "x-request-id":  str(uuid.uuid4()),
        },
        body={"rootPassword": int(secret_id)})
    if code in (200, 201, 202):
        print(f"[ok] resetPassword action triggered (HTTP {code})")
        # Il response contiene info sull'operazione; loggiamo se ha un 'data' field
        if isinstance(data, dict) and "data" in data:
            print(f"     response: {data['data']}")
        return True
    print(f"[ERROR] resetPassword failed (HTTP {code}): {data}", file=sys.stderr)
    sys.exit(4)

# ── Main ───────────────────────────────────────────────────────────
def main():
    env = load_env()
    required = ("CONTABO_CLIENT_ID","CONTABO_CLIENT_SECRET","CONTABO_USERNAME",
                "CONTABO_PASSWORD","CONTABO_INSTANCE_ID")
    missing = [k for k in required if not env.get(k)]
    if missing:
        print(f"[ERROR] mancano nel .env: {', '.join(missing)}", file=sys.stderr)
        print("Aggiungi le righe richieste e rilancia.", file=sys.stderr)
        sys.exit(1)

    token = get_access_token(env)
    new_pw = generate_password(24)
    print(f"[2] generated new password ({len(new_pw)} chars, shell-safe)")

    name = f"vps-{env['CONTABO_INSTANCE_ID']}-{int(time.time())}"
    secret_id = create_password_secret(token, name, new_pw)
    reset_instance_password(token, env["CONTABO_INSTANCE_ID"], secret_id)

    print("[5] writing new VPS_PASSWORD to .env ...")
    update_env_var("VPS_PASSWORD", new_pw)
    print("[ok] .env aggiornato.")

    print("\n[wait] aspetto 90s la propagazione SSH sul VPS...")
    for i in range(90, 0, -10):
        print(f"  ... {i}s")
        time.sleep(10)

    print("\n[DONE] Nuova password applicata e salvata in .env")
    print("       Ora lancia: py scripts\\deploy_user_api_keys.py")

if __name__ == "__main__":
    main()
