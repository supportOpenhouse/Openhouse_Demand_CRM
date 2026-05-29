# OpenHouse Demand CRM

> Production CRM for the OpenHouse demand team (Admin / TL / KAM / Ground).
> Live URL: https://oh-demand-crm.vercel.app
> Owner: Saransh Khera (support@openhouse.in) · Backup: Akshit Chaudhary (akshit@openhouse.in)

---

## Repo layout

```
oh-demand-crm/
├── frontend/                Single-file SPA — Vercel deploys this folder
│   ├── crm.html             ~5,200 lines of CSS + HTML + JS
│   ├── brand/logo-icon.svg
│   ├── openhouse_logo.png
│   └── vercel.json
│
├── backend/                 FastAPI + Postgres — Render deploys this folder
│   ├── api/                 The app
│   │   ├── main.py          Routes (read seed, followups, nudges, notifs, daily tasks, OAuth)
│   │   ├── auth.py          Google SSO @openhouse.in + signed session cookie
│   │   ├── db.py            asyncpg pool
│   │   ├── config.py        Env-var loader
│   │   ├── sheets.py        gspread client
│   │   ├── sheet_sync.py    Sheets → Postgres upsert (brokers, tiers, properties, visits)
│   │   ├── seed_snapshot.py Build the JSON shape the frontend loadSeed() consumes
│   │   ├── bootstrap.py     One-shot: schema + users + first sync + derive CP owners
│   │   └── __init__.py
│   ├── migrations/
│   │   └── 001_initial_schema.sql   16-table schema with partitions + projection trigger
│   ├── requirements.txt
│   └── .env.example
│
├── render.yaml              Render Blueprint (lives at root by Render convention)
│
├── docs/                    All documentation lives here
│   ├── DEPLOY_RUNBOOK.md         ← START HERE if deploying
│   ├── LSQ_HANDOVER.md           ← give to the LSQ migration dev
│   ├── HANDOVER.md               Original (pre-restructure) frontend handover
│   ├── SARANSH_HANDOVER.md       Original 7-week plan from Akshit
│   ├── BACKEND_SCHEMA.md         Full 20-table DDL reference
│   ├── FINDINGS.md               Sheet + LSQ research notes
│   ├── SIMILAR_PROPERTIES_LOGIC_v2.md
│   └── leadsquared/              LSQ tooling reference (read-only)
│
└── archive/                 Pre-restructure assets — kept for reference
    ├── _build_seed.py            Superseded by backend/api/sheet_sync.py
    ├── _fetch_sheets.py
    ├── _fetch_team_retry.py
    ├── _sanitize_seed.py
    ├── seed.json                 Sanitized seed (frontend now loads from /api/seed)
    ├── sheet_snapshots/          Per-tab schema dumps
    └── deploy/                   Netlify mirror — no longer used
```

---

## Where to start

| You are… | Read this |
|---|---|
| Deploying for the first time | [docs/DEPLOY_RUNBOOK.md](docs/DEPLOY_RUNBOOK.md) |
| Wiring LSQ → CRM | [docs/LSQ_HANDOVER.md](docs/LSQ_HANDOVER.md) |
| Understanding the frontend | [docs/HANDOVER.md](docs/HANDOVER.md) |
| Understanding the full backend design | [docs/SARANSH_HANDOVER.md](docs/SARANSH_HANDOVER.md) + [docs/BACKEND_SCHEMA.md](docs/BACKEND_SCHEMA.md) |

---

## Path mapping (pre- vs post-restructure)

If you find a stale reference in one of the original handover docs, here's where files moved to:

| Old path | New path |
|---|---|
| `crm.html` | `frontend/crm.html` |
| `brand/` | `frontend/brand/` |
| `seed.json` | `archive/seed.json` (read-only; runtime loads from `/api/seed`) |
| `_build_seed.py` | `archive/_build_seed.py` (replaced by `backend/api/sheet_sync.py`) |
| `_fetch_sheets.py` etc. | `archive/` |
| `sheet_snapshots/` | `archive/sheet_snapshots/` |
| `leadsquared/` | `docs/leadsquared/` |
| `deploy/` (Netlify mirror) | `archive/deploy/` |
| `api/requirements.txt` | `backend/requirements.txt` |
| `api/render.yaml` | `render.yaml` (must be at root for Render Blueprints) |
| `api/.env.example` | `backend/.env.example` |
| `migrations/` | `backend/migrations/` |
| `HANDOVER.md`, `SARANSH_HANDOVER.md`, `BACKEND_SCHEMA.md`, `FINDINGS.md`, `SIMILAR_PROPERTIES_LOGIC_v2.md`, `LSQ_HANDOVER.md`, `DEPLOY_RUNBOOK.md` | `docs/` |

---

## Day-to-day commands

```bash
# Run backend locally (after `cp .env.example .env` + filling values)
cd backend
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
set -a; source .env; set +a
uvicorn api.main:app --reload

# Run frontend locally against your local backend
cd frontend
python3 -m http.server 8001
# open http://localhost:8001/crm.html
# in DevTools console: window.__OH_API_BASE = 'http://localhost:8000'

# One-shot bootstrap (schema + users + first sync + owners)
cd backend
python3 -m api.bootstrap

# Trigger a sync manually
curl -X POST -H "X-Internal-Cron-Token: $INTERNAL_CRON_TOKEN" \
  "$API_BASE_URL/admin/sync"
```

---

## Production URLs

| Service | URL |
|---|---|
| Frontend | https://oh-demand-crm.vercel.app |
| Backend | https://oh-demand-crm-api.onrender.com |
| DB | Neon (private; `DATABASE_URL` in Render env) |
| OAuth callback | https://oh-demand-crm-api.onrender.com/auth/google/callback |

---

## Support

- Day-to-day, code, ops: **Saransh** — support@openhouse.in
- Roster, business rules, who owns what: **Akshit** — akshit@openhouse.in
- LSQ migration: the dev assigned via [docs/LSQ_HANDOVER.md](docs/LSQ_HANDOVER.md)
