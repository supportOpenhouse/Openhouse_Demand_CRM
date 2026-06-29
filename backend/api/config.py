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

# AMA-register sheet — source of key-handover dates synced daily into
# sheet_key_handovers (Gurgaon / Noida-GN / Ghaziabad tabs). See sheet_sync.
SHEET_ID_KEY_HANDOVERS = os.environ.get(
    "SHEET_ID_KEY_HANDOVERS", "1PZC6MHbqMVldSBWSQ8d7Pw_B101PcofRXFpWaVRWUL8"
)

# How many recent visits to ship to the frontend in /api/seed. IMPORTANT: the seed
# loads the global most-recent N visits and THEN scopes per user, so a scoped KAM/
# Ground user only sees their visits that fall inside this global window. Keep this
# at/above the total visit count so scoped users see their full history (raise it as
# the dataset grows). 1500 silently hid older visits from KAMs with longer books.
SEED_VISITS_LIMIT = int(os.environ.get("SEED_VISITS_LIMIT", "20000"))

# Optional second Postgres (the acquisitions/"properties" DB) — source of the
# key-handover date for the Analytics Property-Status report. Unset = feature
# degrades gracefully (KH columns blank).
PROPERTIES_DATABASE_URL = os.environ.get("PROPERTIES_DATABASE_URL", "")

# Optional read-only Postgres for the Openhouse Meetings app — source of the
# meeting-recordings annotation layer (meetings_sync.run_sync). Read STRICTLY
# READ-ONLY; every write goes to the CRM's own meeting_recordings table. Unset =
# the sync skips, the seed keys are empty, and every 🎙 marker is off (no-op).
MEETINGS_DATABASE_URL = os.environ.get("MEETINGS_DATABASE_URL", "")

# Anthropic API key for the Property Report mailer's visit-feedback summariser
# (Claude Sonnet). Unset = the report still generates with metrics; the AI summary
# section is omitted (graceful degradation). Set in Render's oh-crm-secrets to enable.
ANTHROPIC_API_KEY = os.environ.get("ANTHROPIC_API_KEY", "")

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

# Core app "visit booking" integration (docs/CRM_VISIT_BOOKING_GUIDE.md). The CRM
# backend calls Core server-to-server with the shared X-CRM-Key. Base URL ends in
# /api/v1/oh/ (the 3 booking endpoints are relative to it). Both unset = booking
# returns 503 (feature off) — never logged.
CRM_BOOKING_API_BASE_URL = os.environ.get("CRM_BOOKING_API_BASE_URL", "").rstrip("/")
CRM_API_KEY = os.environ.get("CRM_API_KEY", "")

# Core "CP Meetings — Broker Create" integration (registers channel partners in
# Core; mirrors the Meetings app's Supply→Register-a-partner). Server-to-server
# key (X-CP-Meetings-Key) — separate from the booking key above and never sent to
# the browser. Unset key => the CP-register feature reports "not configured" (503),
# exactly like the app's isCpMeetingsConfigured() guard.
CP_MEETINGS_API_BASE = os.environ.get(
    "CP_MEETINGS_API_BASE", "https://backend-prod-561394753846.asia-south2.run.app/api/v1/oh"
).rstrip("/")
CP_MEETINGS_API_KEY = os.environ.get("CP_MEETINGS_API_KEY", "")

# backend/ root (this file is backend/api/config.py)
BACKEND_ROOT = Path(__file__).resolve().parent.parent
MIGRATIONS_DIR = BACKEND_ROOT / "migrations"
