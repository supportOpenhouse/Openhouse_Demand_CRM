"""Runtime config loaded from env. Imported once at startup; do not mutate."""
import os
from pathlib import Path


def _required(name: str) -> str:
    v = os.environ.get(name)
    if not v:
        raise RuntimeError(f"Missing required env var: {name}")
    return v


DATABASE_URL = _required("DATABASE_URL")

# Google OAuth (web flow) — restricted to ALLOWED_EMAIL_DOMAIN at callback.
GOOGLE_OAUTH_CLIENT_ID = _required("GOOGLE_OAUTH_CLIENT_ID")
GOOGLE_OAUTH_CLIENT_SECRET = _required("GOOGLE_OAUTH_CLIENT_SECRET")
ALLOWED_EMAIL_DOMAIN = os.environ.get("ALLOWED_EMAIL_DOMAIN", "openhouse.in")

# Session cookie signing.
SESSION_SECRET = _required("SESSION_SECRET")
SESSION_MAX_AGE_SECONDS = int(os.environ.get("SESSION_MAX_AGE_SECONDS", str(60 * 60 * 24 * 14)))
SESSION_COOKIE_NAME = os.environ.get("SESSION_COOKIE_NAME", "oh_crm_session")

# Public URLs.
FRONTEND_ORIGIN = os.environ.get("FRONTEND_ORIGIN", "https://openhouse-demand-crm.vercel.app")
API_BASE_URL = os.environ.get("API_BASE_URL", "https://oh-demand-crm-api.onrender.com")

# Google service-account credentials for Sheets. Either inline JSON in env, or a path.
GOOGLE_SERVICE_ACCOUNT_JSON = os.environ.get("GOOGLE_SERVICE_ACCOUNT_JSON", "")
GOOGLE_APPLICATION_CREDENTIALS_PATH = os.environ.get(
    "GOOGLE_APPLICATION_CREDENTIALS_PATH",
    os.environ.get("GOOGLE_APPLICATION_CREDENTIALS", ""),
)

# Source-of-truth sheet IDs.
SHEET_ID_BROKERS = os.environ.get(
    "SHEET_ID_BROKERS", "1bUkpfbceA7lLpMhRh2aoB-oGCwnzUiyD4sIclm25Z1k"
)
SHEET_ID_VISITS = os.environ.get(
    "SHEET_ID_VISITS", "17eEX021t97pGnJasMJ6v7ERE0jezKEC0S8teKepJRWQ"
)
SHEET_ID_INVENTORY = os.environ.get(
    "SHEET_ID_INVENTORY", "1-kxlCnXUv7absl4rpWeMoYIxSAHpWykyjpd9v_5df-o"
)
SHEET_ID_TEAM = os.environ.get(
    "SHEET_ID_TEAM", "18XoHGVorN5cMOIJSvfqS2cS6teGi-iq98xwdCp3ZBjk"
)

# How many recent visits to ship to the frontend in /api/seed.
SEED_VISITS_LIMIT = int(os.environ.get("SEED_VISITS_LIMIT", "1500"))

# Optional second Postgres (the acquisitions/"properties" DB) — source of the
# key-handover date for the Analytics Property-Status report. Unset = feature
# degrades gracefully (KH columns blank).
PROPERTIES_DATABASE_URL = os.environ.get("PROPERTIES_DATABASE_URL", "")

# Local review only. When DEV_MODE=1 the app exposes /auth/dev_login?slug=…
# (no Google round-trip) and serves the frontend at /. NEVER set on Render.
DEV_MODE = os.environ.get("DEV_MODE") == "1"

# Tier sheet-sync. OFF by default: tiers + CP ownership are owned by the CRM
# (one-time import from the CT-assignment sheet, then edited via the frontend
# dropdowns). Re-enable only if you want the team sheet to drive T1/T2 again.
ENABLE_TIER_SYNC = os.environ.get("ENABLE_TIER_SYNC") == "1"

# Sync cadence (seconds). Internal APScheduler used only if RUN_SYNC_IN_PROCESS=1;
# Render's cron is the production trigger.
RUN_SYNC_IN_PROCESS = os.environ.get("RUN_SYNC_IN_PROCESS") == "1"
SYNC_INTERVAL_SECONDS = int(os.environ.get("SYNC_INTERVAL_SECONDS", "900"))

# Internal token for cron-triggered endpoints (Render Cron Job hits /admin/sync with this header).
INTERNAL_CRON_TOKEN = os.environ.get("INTERNAL_CRON_TOKEN", "")

# backend/ root (this file is backend/api/config.py)
BACKEND_ROOT = Path(__file__).resolve().parent.parent
MIGRATIONS_DIR = BACKEND_ROOT / "migrations"
