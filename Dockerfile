# ---------------------------------------------------------------------------
# Stage base: immagine ufficiale Playwright Python — supporta linux/amd64
# e linux/arm64 (QNAP TS-433, Raspberry Pi 4, ecc.)
# ---------------------------------------------------------------------------
FROM mcr.microsoft.com/playwright/python:v1.44.0-jammy

# Evita prompt interattivi durante apt
ENV DEBIAN_FRONTEND=noninteractive
ENV PYTHONUNBUFFERED=1
ENV PYTHONDONTWRITEBYTECODE=1

# Playwright usa questa variabile per trovare i browser già inclusi nell'immagine
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright

WORKDIR /app

# ---------------------------------------------------------------------------
# Dipendenze Python
# ---------------------------------------------------------------------------
COPY requirements.txt .
RUN pip install --no-cache-dir \
        flask>=3.0.0 \
        flask-cors>=4.0.0 \
        apscheduler>=3.10.0 \
        playwright>=1.44.0 \
    && pip install --no-cache-dir -r requirements.txt || true

# I browser Chromium sono già inclusi nell'immagine base — nessun install extra
# RUN playwright install chromium   ← NON necessario con questa immagine

# ---------------------------------------------------------------------------
# Codice applicativo
# ---------------------------------------------------------------------------
COPY scraper.py .
COPY server.py .

# Directory dati persistente (montata come volume su QNAP)
RUN mkdir -p /app/data

# ---------------------------------------------------------------------------
# Esposizione porta e avvio
# ---------------------------------------------------------------------------
EXPOSE 5000

# Healthcheck: /api/ping risponde entro 10 s
HEALTHCHECK --interval=30s --timeout=10s --start-period=20s --retries=3 \
    CMD python -c "import urllib.request; urllib.request.urlopen('http://localhost:5000/api/ping')" \
    || exit 1

CMD ["python", "server.py", "--host", "0.0.0.0", "--port", "5000"]
