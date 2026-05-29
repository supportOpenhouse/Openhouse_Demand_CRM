# OpenHouse Demand CRM · Production Handover

> **Date:** 2026-05-29 (end of build session)
> **Owner:** Saransh Khera (support@openhouse.in / saransh.khera@openhouse.in)
> **Backup:** Akshit Chaudhary (akshit@openhouse.in)
> **State:** Backend live on Render · Frontend live on Vercel · DB live on Neon · Real data (24 users, 4,740 brokers, 7,780 visits, 103 properties) · Sheets sync wired to a 15-min Render cron · OAuth working

This doc is the single page that captures "what's running, what isn't, what to do next." It supersedes any partial guidance from the chat session.

---

## 1. TL;DR — at a glance

| Layer | Status | URL |
|---|---|---|
| **Frontend** | ✅ Live | https://openhouse-demand-crm.vercel.app |
| **Backend API** | ✅ Live | https://oh-demand-crm-api.onrender.com |
| **Database** | ✅ Live with real data | Neon project (us-east-1, region `c-8`) |
| **Sheet sync (cron)** | ✅ Every 15 min via Render Cron | `oh-demand-crm-sheet-sync` |
| **Google OAuth** | ✅ Working (@openhouse.in only) | redirect URI = `https://oh-demand-crm-api.onrender.com/auth/google/callback` |
| **LSQ sync** | ⏸ Not started — handed off to another dev | See [LSQ_HANDOVER.md](LSQ_HANDOVER.md) |

Sign in with any `@openhouse.in` Google account that exists in the `users` table.

---

## 2. What was completed in this session

### 2.1 Repo restructure
- Split into `frontend/` (Vercel root), `backend/` (Render root), `docs/`, `archive/`
- `render.yaml` at repo root (Render Blueprint convention)
- See [README.md](../README.md) for the layout map

### 2.2 Schema (Neon Postgres 17)
- [backend/migrations/001_initial_schema.sql](../backend/migrations/001_initial_schema.sql) — 16 tables, monthly partitions on `followups` + `notifications`, projection trigger from followups → visits
- Schema fix: dropped `UNIQUE` constraint on `idx_followups_lsq` because Postgres forbids partition-table uniques without the partition key
- Idempotent: every `CREATE TABLE IF NOT EXISTS`, every `INSERT … ON CONFLICT`

### 2.3 Backend API (FastAPI on Render)
- [backend/api/main.py](../backend/api/main.py) — routes:
  - `GET /api/seed` — returns the legacy `seed.json` shape (drop-in for the old static file). Now includes `current_user` for runtime user grafting.
  - `GET /api/me` — current session user
  - `POST /api/followups` — saves a followup, resolves nudges, notifies the nudger
  - `POST /api/nudges` — sends a nudge + notification
  - `POST /api/notifications/:id/read` and `/read_all`
  - `POST /api/daily_tasks/pin` and `/unpin` — daily call list
  - `GET /auth/google/start`, `GET /auth/google/callback`, `POST /auth/logout` — Google SSO
  - `POST /admin/sync` — manual sheet sync trigger (used by the cron)
  - `GET /health` — liveness probe
- [backend/api/auth.py](../backend/api/auth.py) — Google OAuth + itsdangerous-signed session cookie, `@openhouse.in` domain check, surfaces Google's error verbatim on 4xx
- [backend/api/db.py](../backend/api/db.py) — asyncpg pool (statement_cache_size=0 because Neon uses transaction-pool pgbouncer)
- [backend/api/sheet_sync.py](../backend/api/sheet_sync.py) — **bulk** sheet-to-DB upsert. Rewritten from row-by-row (~75 min) to chunked `executemany` with prefetched FK maps (~60s for 7,780 visits)
- [backend/api/seed_snapshot.py](../backend/api/seed_snapshot.py) — builds the JSON shape the frontend consumes
- [backend/api/bootstrap.py](../backend/api/bootstrap.py) — one-shot: schema → 24 demand-team users → first sync → derive CP owners + T3/T4 tiers
- [backend/api/sheets.py](../backend/api/sheets.py) — lazy gspread client (env: inline JSON or file path)
- [backend/api/config.py](../backend/api/config.py) — env loader with hard fails on missing required vars

### 2.4 Frontend (Vercel)
- [frontend/index.html](../frontend/index.html) — single-file SPA, **layout preserved** as required (renamed from `crm.html` so Vercel serves it at `/` with no rewrite)
- Surgical patches only:
  - `TODAY = new Date()` (was hardcoded to 2026-05-28)
  - `API_BASE` constant + `apiFetch()` helper that auto-redirects to OAuth on 401
  - `loadSeed()` hits `/api/seed`; grafts the signed-in user from `seed.current_user` into local `USERS`/`USERS_BY_ID` at runtime (so DB-added members sign in without a frontend code change)
  - `saveFollowup()` / `addNudge()` / `markNotificationRead()` / pin / unpin now POST to API before mutating local store
  - `seedDemoActivity()` no longer called — real data drives the UI
  - Impersonation switcher gated to Admin team only (others see Sign Out)
  - Sign Out → `/auth/logout` → fresh OAuth round

### 2.5 Infrastructure
- [render.yaml](../render.yaml) — Blueprint declares the web service + the cron job + the shared `oh-crm-secrets` env group; pins Python 3.12.7
- [frontend/vercel.json](../frontend/vercel.json) — static deploy; the app is served as `index.html` (no rewrite needed), plus cache + security headers
- [backend/.python-version](../backend/.python-version) — 3.12.7 (matches Render, fixes local dev)
- [backend/.env.example](../backend/.env.example) — every env var documented, single-quote convention for shell safety
- [backend/requirements.txt](../backend/requirements.txt) — pinned versions for reproducibility

### 2.6 Docs
- [README.md](../README.md) — top-level pointer + path mapping (pre- vs post-restructure)
- [docs/DEPLOY_RUNBOOK.md](DEPLOY_RUNBOOK.md) — step-by-step deploy from scratch
- [docs/LSQ_HANDOVER.md](LSQ_HANDOVER.md) — full brief for the LSQ migration dev
- This file

### 2.7 Bug fixes along the way
- Python 3.14 wheels missing → pinned to 3.12.7 in `render.yaml` + `.python-version`
- `_pool: asyncpg.Pool | None` failed on Py 3.9 local venv → added `from __future__ import annotations`
- `.env` parse errors on URLs with `&` → docs updated to single-quote values
- Postgres partitioned-table UNIQUE rule → dropped uniqueness on `lsq_activity_id`, dedup in app code
- Sheet sync took 1h+ on Mumbai→us-east-1 latency → rewrote with bulk `executemany`
- Generic 500 on OAuth failures → patched to surface Google's actual `error_description`
- Frontend rejected DB-added users → backend returns `current_user`; the runtime graft in `loadSeed()` was wired up (2026-05-29) so the backend record alone is enough

---

## 3. Live production infrastructure

### 3.1 Render (`oh-demand-crm-api`)
- Region: Singapore
- Plan: Starter (bump to Standard before public launch)
- Auto-deploys on push to `main`
- Cron Job `oh-demand-crm-sheet-sync` runs `curl POST /admin/sync` every 15 min

### 3.2 Render env group `oh-crm-secrets` (currently set)

```
DATABASE_URL                = postgresql://neondb_owner:npg_KrU0qSadhWm5@ep-wispy-bird-aqr2a9u3-pooler.c-8.us-east-1.aws.neon.tech/neondb?sslmode=require&channel_binding=require
GOOGLE_OAUTH_CLIENT_ID      = <from Google Cloud Console>
GOOGLE_OAUTH_CLIENT_SECRET  = <from Google Cloud Console>
SESSION_SECRET              = <generated, secrets.token_urlsafe(48)>
INTERNAL_CRON_TOKEN         = <generated, secrets.token_urlsafe(48)>
GOOGLE_SERVICE_ACCOUNT_JSON = <full SA JSON on one line, for sheet sync>
```

Web-service-level env (not in group):
```
FRONTEND_ORIGIN  = https://openhouse-demand-crm.vercel.app
API_BASE_URL     = https://oh-demand-crm-api.onrender.com
SEED_VISITS_LIMIT = 10000   (bump anytime; total sheet rows = ~7,780 today)
PYTHON_VERSION    = 3.12.7
```

### 3.3 Vercel
- Project: `openhouse-demand-crm`
- Root Directory: `frontend`
- Framework: Other (static)
- Build/install/output commands: all empty

### 3.4 Neon
- Region: us-east-1 (the latency tax is real; see §5.1 for the recommended move)
- DB: `neondb`
- Schema: `public` (16 base tables + 28 monthly partitions)

### 3.5 Google OAuth client
- Type: Web application (Internal — `openhouse.in` workspace)
- Authorized redirect URI: `https://oh-demand-crm-api.onrender.com/auth/google/callback`
- Authorized JS origin: `https://openhouse-demand-crm.vercel.app`
- Scopes: `openid`, `email`, `profile`

### 3.6 Database state (as of handover)
```
users               : 24 demand-team + saransh.khera + (any others manually added)
brokers             : 4,740   (sheet upsert auto-catches new rows)
visits              : 7,780   (every row in the visitors sheet)
properties          : 103
buyers              : ~4,588  (deduped by lead_key)
tier_assignments    : 250 (T1+T2 from team sheet) + 4,488 (T3/T4 derived)
cp_assignments      : 4,738 (every broker has a current owner)
property_assignments: 100 (active properties matched to PM)
```

---

## 4. What works today

### 4.1 Read paths (all real data)
- Visits list (filter by status / stage / city / followup / priority / search)
- CP / Broker list (filter by tier / city / activity / search)
- Properties grid (filter by city / status)
- Queue (unassigned brokers)
- Notifications inbox
- Broker popup (visits / engagement / timeline tabs)
- Property popup
- Inventory snapshot view (text + image share via html2canvas)
- Today banner (overdue, pending nudges, daily calls, unread)
- Mobile mode (≤900px)

### 4.2 Write paths (persisted)
- ✅ **Save followup** — `POST /api/followups`, resolves nudges, notifies the nudger
- ✅ **Add nudge** — `POST /api/nudges`, notifies the owner
- ✅ **Mark notification read** + **mark all read**
- ✅ **Pin CP to daily call list** + **unpin**
- ✅ **Sign in / out** — Google OAuth

### 4.3 Background work
- ✅ Sheet sync every 15 min (brokers + visits + properties + T1/T2 tiers)
- ✅ Followup → visit projection (DB trigger keeps `visits.current_*` in sync with latest `followups` row)
- ✅ Sheet sync log table (`sheet_sync_log`) — every run recorded

---

## 5. What does NOT work yet

### 5.1 In-memory only (data lost on page refresh)
These render but their mutations don't persist — listed in priority order for the next dev:

| Feature | Where | Fix |
|---|---|---|
| **Bulk reassign visits → RM** | `setupBulkApply()` ctx='visits' | Add `POST /api/visits/bulk_reassign` |
| **Queue → assign to KAM/Ground + set tier** | `setupBulkApply()` ctx='queue' | Add `POST /api/brokers/bulk_assign` (writes both `cp_assignments` and `tier_assignments`) |
| **Engagement form save** | `saveEngagement()` (search the file) | Add `POST /api/engagements` — table already exists |
| **Add/edit team member** | `openMemberEditor()` | Add `POST /api/users` and `PATCH /api/users/:slug` (Admin only) |
| **Send message** (1-to-1) | "Send" button in Team detail | Add `POST /api/messages` — schema needs a new `team_messages` table or reuse `notifications` with type=`message_dm` |
| **Broadcast message** | "Broadcast" button | Same as above, fan-out write |
| **Admin tier dropdown in broker popup** | side panel | Add `POST /api/brokers/:cp/tier` |
| **Admin CP owner dropdown in broker popup** | side panel | Add `POST /api/brokers/:cp/owner` (closes current `cp_assignments` row, opens new) |

All of these are 30-60 min of work each — they're scoped out only because of the "ship today" constraint. The DB schema already supports all of them.

### 5.2 Bigger gaps for v1.1

| Gap | Notes |
|---|---|
| **LSQ followup history** | Hand-off to a separate dev — see [LSQ_HANDOVER.md](LSQ_HANDOVER.md). Not wired at all today. Adds ~50k historical followups when done. |
| **Overdue notification cron** | Schema supports it; need a daily job that scans `visits.next_followup_date < today AND current_stage NOT IN ('booking','ats','cancelled','not_interested','need_more')` → INSERT into `notifications`. Add as a second Render Cron Job. |
| **Server-side scope filter on `/api/seed`** | Currently the API returns ALL data to any authenticated user. Frontend filters by role/city in `visitsForUser()` etc. — fine for an internal 28-user CRM, **not** acceptable if any user is ever external. Tighten before any non-employee gets access. |
| **WhatsApp Business API** | Currently uses `wa.me` (opens app, user attaches images manually). Costs money + setup; do later. |
| **Neon region migration** | DB is in **us-east-1** but users + Render are in Singapore + India. Every API call has a ~150ms round-trip. Recommend: clone Neon project to `ap-southeast-1`, dump+restore data (or use Neon branching with region change), update `DATABASE_URL`. Would cut sync times ~5x and `/api/seed` first-paint by ~200ms. |
| **Materialized views from BACKEND_SCHEMA.md §"Derived"** | `mv_broker_stats` and `mv_user_dashboard` not built yet. Counts come from live SQL today — fast enough at current volume. Add when broker count exceeds ~20k. |

### 5.3 Tables in the schema that nothing writes to yet
- `engagements` — UI exists, write path missing
- `events` — universal event log (skipped for v1, see BACKEND_SCHEMA.md)
- `integration_log` — for LSQ dev
- `feature_flags` — empty; not needed yet
- `wa_templates` — has 5 default rows but the frontend still hardcodes templates in `WA_TEMPLATES` array

---

## 6. Known issues & gotchas

| Issue | Workaround / note |
|---|---|
| **Neon → us-east-1 latency** | Sheet sync takes ~60s instead of ~10s if Neon were in ap-southeast-1. Acceptable for v1. |
| **Frontend USERS array is hardcoded** | The 24 demand-team people live in `index.html` (the `USERS` array, ~line 1308). New DB users get grafted at runtime via `seed.current_user`, so they can sign in fine — but they appear in other users' dropdowns / impersonation menus **only after** they first log in. Cleaner long-term: have the API return the full users list and drop the hardcoded array (see §8 todo #8). |
| **OAuth codes are single-use** | If a callback URL errors, refreshing it will give `invalid_grant`. Always start a fresh login (new tab) when debugging. |
| **`@openhouse.in` domain enforcement** | The `hd` param in the OAuth URL nudges Google to show only `@openhouse.in` accounts, but Google doesn't enforce it strictly. The backend re-checks `email.endswith('@openhouse.in')` after token exchange. |
| **`set -a; source .env` in zsh** | Zsh's `interactive_comments` is off by default. Don't paste shell comments (`# something`) at the prompt — apostrophes in words like "you're" break quoting. |
| **`unc` status string** | Means "Not Updated" in UI. The WhatsApp template builders suppress it before sending. Don't rename it casually — every chip, filter, and template branches on this exact string. |
| **Visit `_stage` vs `current_stage`** | `index.html` uses `v._stage` (local override) AND `seed_snapshot.py` returns `_stage` from `visits.current_stage`. Naming inconsistency is intentional: the legacy frontend reads `v._stage` first, falls back to deriving from `lead_status`. |
| **Vercel rebuild on render.yaml change** | Vercel doesn't see `render.yaml` (it's outside `frontend/`), but it WILL rebuild on every push to main. To pause that: Vercel project Settings → Git → ignore the push if no files in `frontend/` changed. |
| **Sheet sync second-write conflict** | If two cron runs overlap (shouldn't happen now that it's <1 min), `executemany` ON CONFLICT serializes fine. No data loss. |

---

## 7. How to keep it running

### 7.1 Daily ops (5 min/day)
1. Render → `oh-demand-crm-api` → **Logs** — eyeball for unhandled exceptions overnight
2. Neon SQL Editor:
   ```sql
   SELECT sheet_name, status, rows_inserted, rows_updated, run_started_at
     FROM sheet_sync_log
    WHERE status != 'success' AND run_started_at > now() - interval '24h'
    ORDER BY run_started_at DESC;
   ```
   0 rows expected.

### 7.2 Weekly ops
- Render → Metrics → response p95 < 800ms
- Neon → DB size (free tier ceiling is 3 GB; currently <50 MB)

### 7.3 Monthly ops
- Add new monthly partitions for `followups` and `notifications`. Current pre-created partitions go through `2027-06`. Around April 2027, run:
  ```sql
  DO $$
  DECLARE m date := date '2027-07-01'; i int;
  BEGIN
    FOR i IN 0..11 LOOP
      EXECUTE format(
        'CREATE TABLE IF NOT EXISTS followups_%s PARTITION OF followups FOR VALUES FROM (%L) TO (%L);',
        to_char(m + (i || ' months')::interval, 'YYYY_MM'),
        (m + (i || ' months')::interval)::date,
        (m + ((i+1) || ' months')::interval)::date
      );
      EXECUTE format(
        'CREATE TABLE IF NOT EXISTS notifications_%s PARTITION OF notifications FOR VALUES FROM (%L) TO (%L);',
        to_char(m + (i || ' months')::interval, 'YYYY_MM'),
        (m + (i || ' months')::interval)::date,
        (m + ((i+1) || ' months')::interval)::date
      );
    END LOOP;
  END $$;
  ```

### 7.4 Adding a new team member
```sql
INSERT INTO users (slug, email, name, team, role, cities)
VALUES ('<short-slug>', '<email>@openhouse.in', '<Full Name>',
        '<Admin|TL|KAM|Ground>', '<admin|tl_head|tl_closer|kam|kam_tl|ground>',
        ARRAY['<city>',...])
ON CONFLICT (email) DO UPDATE SET active=true;
```
They can sign in immediately — the frontend grafts them via `seed.current_user` on login. Note: they won't appear in *other* users' impersonation/assignment dropdowns until they've logged in at least once (the hardcoded `USERS` array in `index.html` doesn't know about them yet). For someone who must be visible to everyone from day one (e.g. a new admin), also add them to that array and redeploy.

### 7.5 Re-running sheet sync on demand
```bash
curl -X POST \
  -H "X-Internal-Cron-Token: <INTERNAL_CRON_TOKEN from Render env>" \
  https://oh-demand-crm-api.onrender.com/admin/sync
```

### 7.6 Reset everything (nuclear option, ONLY if no real follow-ups have been saved)
```bash
cd /Users/saranshkhera/Documents/GitHub/oh-demand-crm/backend
source .venv/bin/activate && set -a; source .env; set +a
psql "$DATABASE_URL" -c "DROP SCHEMA public CASCADE; CREATE SCHEMA public;"
python3 -m api.bootstrap
```
Then re-run the bulk-load script for visits (in chat history; reach out if you need it again).

---

## 8. Open todos for the next session

In rough priority order:

1. **Wire bulk reassign** (visits + queue) — biggest UX gap; demand TLs need this
2. **Wire engagement form save** — KAMs use this daily
3. **Wire admin tier/owner dropdowns** in broker popup
4. **Daily overdue cron** → notifications
5. **Migrate Neon to ap-southeast-1** for latency
6. **Hand off LSQ dev** with [LSQ_HANDOVER.md](LSQ_HANDOVER.md) — they can start Phase A any time
7. **Server-side scope filter on `/api/seed`** before any external user
8. **Remove hardcoded USERS array** from `index.html` — replace with API-driven list (the runtime graft now covers the signed-in user; this would cover everyone)
9. **Materialized views** when broker count > 20k
10. **WhatsApp Business API** for real sends (when budget allows)

---

## 9. Where to find things

| Looking for… | Path |
|---|---|
| Frontend SPA | [frontend/index.html](../frontend/index.html) |
| FastAPI routes | [backend/api/main.py](../backend/api/main.py) |
| Schema DDL | [backend/migrations/001_initial_schema.sql](../backend/migrations/001_initial_schema.sql) |
| Sheet sync logic | [backend/api/sheet_sync.py](../backend/api/sheet_sync.py) |
| OAuth flow | [backend/api/auth.py](../backend/api/auth.py) |
| Render deploy config | [render.yaml](../render.yaml) |
| Vercel deploy config | [frontend/vercel.json](../frontend/vercel.json) |
| Env var template | [backend/.env.example](../backend/.env.example) |
| Step-by-step deploy | [docs/DEPLOY_RUNBOOK.md](DEPLOY_RUNBOOK.md) |
| LSQ migration spec | [docs/LSQ_HANDOVER.md](LSQ_HANDOVER.md) |
| Full 20-table reference | [docs/BACKEND_SCHEMA.md](BACKEND_SCHEMA.md) |
| Original frontend handover | [docs/HANDOVER.md](HANDOVER.md) |
| Original architecture plan | [docs/SARANSH_HANDOVER.md](SARANSH_HANDOVER.md) |
| Sheet research notes | [docs/FINDINGS.md](FINDINGS.md) |

---

## 10. Support

- **Code, ops, anything technical:** Saransh — support@openhouse.in
- **Business rules, roster, who owns what:** Akshit — akshit@openhouse.in
- **LSQ migration:** the developer who picks up [LSQ_HANDOVER.md](LSQ_HANDOVER.md)

Slack channel: `#demand-crm-ops` (suggested — create if not yet)
