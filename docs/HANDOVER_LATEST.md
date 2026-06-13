# OpenHouse Demand CRM — Handover (LATEST · 2026-06-13)

> **This is the current, authoritative handover.** It supersedes the dated ones
> (`PROD_HANDOVER.md`, `SESSION_HANDOVER_2026-06.md`, `SARANSH_HANDOVER.md`, …) —
> those remain as history. Read **§4 (the Working Playbook)** to actually operate
> and change the CRM the way it's been done in the live working sessions:
> investigate prod, test as any user, make a change, validate, deploy.
>
> **Owners:** Akshit Chaudhary (akshit@openhouse.in) · Saransh Khera (support@openhouse.in)

---

## 0. TL;DR — what & where

A 4-team demand CRM (Admin / TL / KAM / Ground) for OpenHouse. Brokers ("channel
partners"/CPs) bring buyers to visit properties in Gurgaon / Noida / Ghaziabad.

| Layer | Tech | URL / location |
|---|---|---|
| Frontend | **React + Vite** (SPA) | https://openhouse-demand-crm.vercel.app (Vercel) |
| Backend | **FastAPI** (Python 3.12) | https://oh-demand-crm-api.onrender.com (Render) |
| Database | **Neon Postgres 17** | `us-east-1`, host `ep-wispy-bird-aqr2a9u3-pooler…` |
| Auth | Google SSO (@openhouse.in only) | session cookie, first-party via Vercel proxy |
| Sheet sync | Render cron, every 15 min | brokers / visitors / inventory → DB |
| Repo (private) | GitHub | `github.com/supportOpenhouse/Openhouse_Demand_CRM` |

The frontend calls the backend **same-origin** (`/api/*`, `/auth/*`): Vercel
rewrites proxy those to Render (see `frontend/vercel.json`), so the session cookie
is first-party (works on mobile). No CORS in normal operation.

---

## 1. Repo layout (current)

```
Openhouse_Demand_CRM/
├── frontend/                 React + Vite app (Vercel root)
│   ├── index.html            Vite shell (just <div id=root> + main.jsx)
│   ├── vercel.json           rewrites /api,/auth,/health → Render + cache headers
│   ├── package.json          deps: react, react-dom, html2canvas (no chart lib)
│   └── src/
│       ├── App.jsx           shell: nav (NAV array), view render switch, impersonation
│       ├── api.js            apiFetch (same-origin, credentials:'include'), loadSeed, write calls
│       ├── views/            VisitsView, CpView, PropertiesView, QueueView, TeamView,
│       │                     NotificationsView, SnapshotView, AnalyticsView
│       ├── components/       BrokerModal, PropertyModal, UserModal, FiltersModal, …
│       ├── lib/              visits.js (stage/status/scope), analytics.js, legacy.js, …
│       ├── app.css / theme.css   light theme; tokens in theme.css (:root)
├── backend/                  FastAPI (Render root = backend/)
│   ├── api/
│   │   ├── main.py           all routes (read seed + writes + OAuth + admin sync)
│   │   ├── auth.py           Google OAuth + signed session cookie (SameSite=Lax)
│   │   ├── seed_snapshot.py  build() the /api/seed payload + scope_for_user() per role
│   │   ├── sheet_sync.py     Sheets → Postgres upsert (brokers/visits/inventory)
│   │   ├── import_ct_assignments.py   one-off CP owner/tier import from CT sheet
│   │   ├── import_top_brokers.py      99acres top-brokers import
│   │   ├── bootstrap.py      one-shot schema + users + first sync
│   │   ├── db.py / config.py / sheets.py
│   │   └── migrations/ 001_initial_schema · 002_top_brokers_99acres · 003_visit_date_and_old_lead
├── lsq_sync/                 one-shot LeadSquared → CRM migration + write-back (DONE)
│   ├── migrate.py · writeback.py · README.md · backups/ (gitignored)
├── render.yaml               Render blueprint (web + cron)
└── docs/                     all handovers + schema + runbooks (this file = latest)
```

> Cleanup nit: `backend/api/import_top_brokers 2.py` is an accidental duplicate (space in name) — safe to delete.

---

## 2. Credentials & access (locations — never commit values)

| Secret | Where it lives |
|---|---|
| Neon `DATABASE_URL` (incl. password) | local `.env` at `~/Documents/Claude Code/_archive/Demand-CRM-old/.env` + Render env group `oh-crm-secrets` |
| `SESSION_SECRET` (cookie signing) | same local `.env` + Render. **Local value matches prod** → you can mint valid cookies (see §4.2). |
| Google OAuth client id/secret | local `.env` + Render + Google Cloud Console |
| Google service-account JSON (Sheets) | inline in local `.env` (`GOOGLE_SERVICE_ACCOUNT_JSON`) + Render |
| LSQ API keys (`LSQ_API_HOST`,`LSQ_ACCESS_KEY`,`LSQ_SECRET_KEY`) | `~/Documents/Claude Code/Credentials/.env` |
| Vercel | project `openhouse-demand-crm` = `prj_7A4AyXhdcNnBBWPvzEFscfjZ50Uh`; team `supportopenhouses-projects` = `team_HPCnkwW6wT0SSeYmuCueVYTU`. **Deploy token** = a personal Vercel token from an **Owner/Admin** of the team (Vercel → Settings → Tokens) — **not stored in any `.env`**; create/rotate & use per deploy. |
| `INTERNAL_CRON_TOKEN` (sheet sync trigger) | local `.env` + Render |

**Two repos on disk:** work in `~/Documents/Claude Code/Openhouse_Demand_CRM` (prod).
The OLD pre-restructure prototype was **moved to `~/Documents/Claude Code/_archive/Demand-CRM-old/`**
(2026-06-08) — but note its `.env` is still the one that holds the live `DATABASE_URL` / `SESSION_SECRET`
(plus `SESSION_COOKIE_NAME`, `GOOGLE_SERVICE_ACCOUNT_JSON` for sheet reads, `INTERNAL_CRON_TOKEN`) used in
the recipes below. If it moves again, `grep -rl ep-wispy-bird ~/Documents/Claude\ Code/*/.env` finds it.

---

## 3. ⭐ THE WORKING PLAYBOOK — operate & change the CRM (read this)

This is *how the live sessions worked*: investigate prod read-only, reproduce what a
user sees by minting a session cookie, make a surgical change, validate in layers,
deploy. Reuse these recipes.

### 4.0 Load env (used by every recipe)
```python
env = {}
for l in open("/Users/akshit.chaudhary/Documents/Claude Code/_archive/Demand-CRM-old/.env"):
    l = l.strip()
    if l and not l.startswith("#") and "=" in l:
        k, v = l.split("=", 1); env[k.strip()] = v.strip().strip("'").strip('"')
```
> Neon's `us-east-1` host is flaky from this network (intermittent DNS `REFUSED`).
> Guard DB calls: `until python3 -c "import socket; socket.getaddrinfo('ep-wispy-bird-aqr2a9u3-pooler.c-8.us-east-1.aws.neon.tech',5432)"; do sleep 3; done`
> psycopg2 treats literal `%` in SQL as a placeholder — **parameterize `ILIKE %s` patterns** (don't inline `'%foo%'`).

### 4.1 Query prod DB (read-only — safe)
```python
import psycopg2
c = psycopg2.connect(env["DATABASE_URL"], connect_timeout=25); c.set_session(readonly=True)
cur = c.cursor(); cur.execute("SELECT count(*) FROM visits"); print(cur.fetchone())
```
Key tables: `users, brokers, properties, buyers, visits, followups, engagements, nudges,
notifications, cp_assignments, property_assignments, tier_assignments, sheet_sync_log,
top_brokers_99acres`. Current owner/tier come from the `effective_to IS NULL` rows
(views `v_broker_current_owner`, `v_broker_current_tier`, `v_property_current_pm`).

### 4.2 ⭐ Test as ANY user — no Google login needed (mint a session cookie)
The local `SESSION_SECRET` equals prod's, so you can forge a valid cookie for anyone:
```python
import itsdangerous
cur.execute("SELECT id,email,slug FROM users WHERE slug=%s", ('ayush',)); u = cur.fetchone()
tok = itsdangerous.URLSafeTimedSerializer(env["SESSION_SECRET"], salt="oh-crm-session") \
        .dumps({"uid": str(u[0]), "email": u[1], "slug": u[2]})
cookie = {"Cookie": env["SESSION_COOKIE_NAME"] + "=" + tok}
```
This is how every prod check was done — reproduce exactly what a user sees.

### 4.3 See what a user's dashboard gets (the scoped seed)
```python
import urllib.request, json
d = json.loads(urllib.request.urlopen(urllib.request.Request(
    "https://openhouse-demand-crm.vercel.app/api/seed", headers=cookie), timeout=90).read())
print(len(d["visits"]), len(d["properties"]), d["current_user"]["name"])
```
`/api/seed` returns the whole UI payload, **scoped to that user** by `scope_for_user()`
(see §5). Admin/TL get everything; KAM/Ground get their slice. This is the fastest way
to diagnose "user X can't see Y" bugs (e.g., the Ayush properties bug — §8).

### 4.4 Make a FRONTEND change → deploy
1. Edit under `frontend/src/`. **`index.html` is just the Vite shell** — real UI is in `src/`.
2. Build: `cd frontend && npm install && npm run build` (must be clean; Vite content-hashes assets).
3. **Render smoke test with real data** (validate before prod): copy `dist/*` to a temp dir, drop the real `/api/me` + `/api/seed` (minted-cookie fetch, §4.2-4.3) into `<dir>/api/me` and `<dir>/api/seed`, serve it (`python3 -m http.server`), open in a browser and click through. `api.js` uses same-origin, so the built app loads the stubbed data exactly like prod.
4. Deploy (Vercel is **owner-gated** — see §8): from repo root with `.vercel/project.json = {"projectId":"prj_7A4AyXhdcNnBBWPvzEFscfjZ50Uh","orgId":"team_HPCnkwW6wT0SSeYmuCueVYTU"}`:
   `npx vercel deploy --prod --yes --token=<OWNER_VERCEL_TOKEN>`
   **Confirmed working 2026-06-08.** The token must belong to an **Owner/Admin** of `supportopenhouses-projects` (akshit's personal token works). `vercel deploy` uploads the repo and builds `frontend/` on Vercel (project root dir = `frontend`), then aliases the build to `openhouse-demand-crm.vercel.app`. A `git push` does **not** auto-deploy Vercel here.
5. Post-deploy: confirm the live `/assets/index-*.js` hash changed and `grep` the live bundle for your new strings; existing view labels still present (no regression). (Recipe: fetch `/` for the hash, fetch the bundle and `grep` for your marker, and mint-cookie `/api/seed` to confirm any backend field is live.)

### 4.5 Make a BACKEND change → deploy
1. Edit under `backend/api/`. `py_compile` it.
2. Commit + **push to `main`** → **Render auto-deploys** (it does *not* have Vercel's author gate; ~3-5 min).
3. Post-deploy: poll the live endpoint until the new behaviour appears, then validate across roles (mint cookies for an affected user, a control user, and admin) and confirm `/health`=200.

### 4.6 Validation discipline (the "3 layers")
- **L1 merge:** `git fetch`; confirm `main` hasn't moved / your branch merges clean (`git merge-tree`).
- **L2 build:** `npm run build` (frontend) or `py_compile` (backend) — clean.
- **L3 functional:** run the real logic over real data (engine over the live seed; or the render smoke test; or mint-cookie `/api/seed`). After deploy, re-validate on the live URL across multiple users — **always include a control user to prove no regression.**

### 4.7 Deploy reference
| Target | How | Auto? |
|---|---|---|
| **Backend** (Render) | `git push origin main` | ✅ auto on push |
| **Frontend** (Vercel) | `npx vercel deploy --prod --token=<owner token>` from repo root | ❌ git pushes are **blocked** unless the pusher's GitHub is a connected Vercel team member (§8) |
| **Sheet sync** | Render cron `*/15` → `POST /admin/sync`; manual: `curl -X POST -H "X-Internal-Cron-Token: $INTERNAL_CRON_TOKEN" $API/admin/sync` | ✅ |

---

## 5. Data model & scoping (the business logic that bites)

- **Visit** = a buyer's visit to a property (table `visits`, ~8,200 rows). Carries denormalized
  fields: `city, society_name, unit_address_line1/2, sales_manager, broker_name/company_name/cp_code,
  buyer_name/buyer_contact, status (completed/upcoming/cancelled), lead_status (hot/warm/cold/dead/future_prospect/select_status),
  source (channel_partner/direct), listing_status (Sd/Rdy/Arc/Bkd/CS), selected_date/visit_date, added_by`.
- **Ownership/tiers are CRM-owned** (temporal tables `cp_assignments`, `tier_assignments`,
  `property_assignments`), edited via admin dropdowns. The 15-min sheet sync no longer drives tiers
  (`ENABLE_TIER_SYNC=0`). It DOES keep overwriting `properties.sales_manager`/`brokers` text from the sheets.
- **`scope_for_user()`** (`seed_snapshot.py`) filters `/api/seed` per role: Admin = all; TL = their cities;
  KAM = own CPs (+ all properties for inventory); Ground = own CPs + visits/properties they're the PM of.
  **Lesson learned:** scope by the *assignment tables* (slug), not by matching sheet name-text to a
  user's full name (sheets store some PMs by first name → silent zero-results; see §8).

---

## 6. API endpoints (`backend/api/main.py`)
Read: `GET /api/me`, `GET /api/seed`, `GET /api/top-brokers`.
Writes (all persisted, permission-checked): `POST /api/followups`, `/api/nudges`,
`/api/notifications/{id}/read`, `/api/notifications/read_all`, `/api/daily_tasks/pin|unpin`,
`/api/engagements`, `/api/brokers/{cp}/tier`, `/api/brokers/{cp}/owner`, `/api/brokers/bulk_assign`,
`/api/visits/bulk_reassign`, `POST /api/users` + `PATCH /api/users/{slug}` (admin),
`/api/top-brokers/{id}/phone`. Auth: `/auth/google/start|callback`, `/auth/logout`,
`/auth/dev_login` (only when `DEV_MODE=1`). Ops: `POST /admin/sync`, `GET /health`.

---

## 7. Frontend features (`frontend/src/views/`)
Visits · Channel Partners · Properties · **Analytics** · To Be Assigned (admin) ·
Inventory Snapshot · Team/My Day · Notifications. Modals: Broker, Property, User (add/edit), Filters.
Admin "impersonation" switcher re-scopes every view to view-as-another-user.

**Analytics tab** (`AnalyticsView.jsx` + `lib/analytics.js`): 11 filters (Status default Completed),
8 dependency-free SVG charts + a filtered raw table with CSV download, all cross-filtering on click.
Apartment = `addr2 · addr1 · society`. "View in Google Sheets" is stubbed (fast-follow).

---

## 8. Gotchas / landmines (hard-won)
- **Vercel deploys are owner-gated.** Git/hook deploys are blocked unless the commit author's GitHub
  account is a *connected* member of the Vercel team (re-verified 2026-06-08: a `git push origin main` did
  **not** trigger a Vercel build — only Render rebuilt). Working method: deploy with an **Owner/Admin Vercel
  token** (`npx vercel deploy --prod --yes --token=…` from repo root) — uploads files, bypasses the author
  check. The token is a personal token (akshit's works) and is **not stored on disk**; create/rotate it in
  Vercel → Settings → Tokens. To-do: connect `akshit-openhouse`'s GitHub to the team so normal pushes auto-deploy.
- **Render deploys fine on any push** (no author gate) — that's why backend changes ship via `git push main`.
- **Neon `us-east-1` is flaky from this link** — retry on `getaddrinfo`.
- **Stale browser cache** caused two false alarms ("login loop", "data not updating"). The backend was
  fine both times; a refresh / incognito fixed it. `/` HTML is `no-cache`; data is never cached.
- **Sheet sync overwrites `properties.sales_manager` / broker text every 15 min** — never "fix" data in
  those columns; fix the code or the source sheet. (This is why the Ayush scope bug needed a code fix.)
- **Ground-PM scope by name** silently hid all properties for PMs whose sheet name is a first name only
  ("Ayush" vs user "Ayush Ojha"). Fixed 2026-06-05 to scope by `pm_by_property` (assignment) with the
  name-match as fallback. Affected Ayush Ojha + Abhishek Dwivedi.
- **LSQ is eventually-consistent** — `Lead.Update` returns Success but `GetById` lags seconds; validate
  write-backs after a delay (relevant only to `lsq_sync/`, which is one-shot/done).
- **`/api/seed` is large for admins (~13 MB)** — fetches can be slow; bump timeouts.

---

## 9. Recent change log
- **2026-05-29 → 06-01 (Claude session):** config/URL fixes; LSQ→CRM one-shot migration (3,817 visits
  enriched, 26 inserted, 2,808 followups) + write-back (`mx_Test='a'` on 1,248 leads, reversible); 3-round
  validation; mobile login-loop fix (first-party cookie via Vercel proxy). See `SESSION_HANDOVER_2026-06.md`.
- **2026-06-03 → 04 (Saransh):** full **React/Vite rebuild** of the frontend; persisted all previously
  in-memory write paths (engagements, tier/owner, bulk assign/reassign, add/edit users); 99acres top-brokers
  (migration 002 + importer); visit_date normalization (migration 003); CP-owner mass reassignment
  (`cp_reassign_2026_06`, 1,963 brokers); filters/impersonation/kam_tl fixes; `DEV_MODE`.
- **2026-06-05 (Claude session):** **Analytics tab** shipped (PR #2, deployed + validated). **Ground-PM
  property scope fix** (Ayush/Abhishek) shipped to prod + validated across users.
- **2026-06-08 (Saransh + Claude session):** Saransh: `SEED_VISITS_LIMIT`→20000 (scoped KAM/Ground were
  missing older visits — the seed loads the global most-recent N *then* scopes) + Visits default filter now
  shows all FU states (`6e75d57`). On top: **home_id unit mapping** (`1440b45`) — `seed_snapshot` exposes
  `home_id` (visits + properties; migration 004 + sheet sync already populate it, ~98%); **PropertyModal**
  scopes visits to the **unit** by `home_id` not society (Godrej Oasis A-704: 51 visits, was 325);
  **`priceForVisit`** joins by `home_id` so each unit shows its own price (A-704 = ₹2.35 Cr, was the society's
  ₹2.14) + guards the substring fallback; `vercel.json` no-caches `/`. Validated Admin/TL/KAM/Ground against
  the live backend (0 mispriced of 3.5k home_id joins), then deployed (backend push→Render; frontend
  owner-token `vercel deploy`). The **"Mayank/Saket can't see visits" report was stale browser cache**, not a
  bug — their seeds were correct (Mayank 606 visits, Saket 339).
- **2026-06-08 (later · Saransh + Claude):** Saransh shipped a 9-commit batch (→`22404b2`): **old-leads
  redefined** — `is_old_lead` now means "the unit is no longer live inventory" (not the pre-1-May date rule),
  maintained on `visits.is_old_lead` by `sheet_sync.sync_inactive_leads()` (**migration 005**); dead-lead
  follow-ups disabled; PropertiesView/SnapshotView reworks; FiltersModal/CpView tweaks; admin-only CSV. On top
  (`b1a0b0d`): **(1) city via home_id** — `seed_snapshot` derives a visit's city from its home_id-mapped
  inventory unit, fixing 267 visits whose Visitors-sheet city was mis-entered (Supertech Livingston / Saviour
  Greenisle were Noida → now Ghaziabad). Corrects the list, city tabs, **scoping** (those visits leave the
  Noida TL and join Ghaziabad) and analytics. **(2) Ground-PM scope** now also includes visits where the PM is
  the RM (`sales_manager`) — a PM sees visits they personally ran even at others' properties / non-owned CPs
  (fixed VST8592 hidden from Abhash; mirrored in `scopeVisits`). **(3) Revisit column** — sortable, desktop +
  mobile, surfaces `visits.revisit_date` (`↻ <date>`) + a chip in the Property/CP popups. **(4) Engagement
  tab** got the Close/HubSpot 2-axis model: `connected` disposition + `outcome` (set only when connected) + a
  follow-up date, history enriched (**migration 006** — expand/idempotent, applied to prod). Validated
  L1/L2/L3 across Admin/TL/KAM/Ground + render smoke + a live engagement save round-trip; deployed (backend
  push→Render; frontend owner-token `vercel deploy`).
- **2026-06-09 (Claude session — DB changes APPLIED to prod; backend + frontend code NOT yet deployed):**
  Five-part batch.
  **(A) Old-lead / dead hardening (DB applied):** `sheet_sync.sync_inactive_leads()` now runs **last** in
  `run_all()` and re-derives old/dead from `all_properties` *after* the visit upsert, so the 15-min sheet
  sync can no longer revert an unworked dead lead's `lead_status` (root cause of the "VST8807 shows Not
  Updated" report). It also clears `next_followup_date`/`revisit_date` on dead leads. `nextFuFor` returns
  null for dead leads (Next-FU column → "No FU", excluded from the overdue filter). Selecting **Dead** in
  either follow-up form disables the Next-FU date; `/api/followups` also forces FU / revisit / negotiation
  dates to null when `buyer_status='dead'`, server-side. One-time DB cleanup zeroed 64 dead-with-FU rows;
  all 5,685 old leads verified dead + FU-free.
  **(B) Follow-up filter repurposed (Visits + Channel Partners):** was "last FU taken" → now **next-FU /
  pending work** — `All / 🚨 Overdue / Due Today / Due Tomorrow / Due This Week / ⚠️ No next-FU set`
  (`FU_PRESETS` + `matchFuFilter` in `lib/visits.js`, replacing `LAST_FU_PRESETS`/`matchLastFuFilter`).
  Operates on `next_followup_date`; **excludes Upcoming/Cancelled (not-completed) and Dead** visits. CpView
  matches a CP if any of its visits matches (`cpMatchesFu`).
  **(C) "Next Activity" column** at the end of the Visits table (sortable, desktop + mobile): shows the
  scheduled **revisit (↻)** or **negotiation meeting (🤝)** date+time with a hover tooltip
  (`nextActivityFor` + `fmtDateTime`); replaces the old "Revisit" column.
  **(D) Negotiation meeting + new stage (migration 007 — APPLIED to prod):** picking **Negotiation** in a
  follow-up now asks for a meeting date (mirrors Revisit Scheduled); new stage **After Negotiation FU**,
  auto-applied once the date passes (`visitStage`). New `negotiation_date` column on `followups` + `visits`,
  projection trigger updated, `/api/followups` validates + stores it, seed exposes `_negotiation_date`.
  **(E) New "Home" tab — now the DEFAULT landing view** (`HomeView.jsx`, `App.jsx` NAV): a Today / Tomorrow
  board split into **Revisits / Negotiation Meetings / Follow-ups Due** (distinct groups, not one list).
  **Admin/TL see everyone grouped by person; KAM/Ground see their own** (scoped via `scopeVisits`).
  **Migration-number note:** the negotiation migration was renumbered **006 → `007_negotiation_date.sql`** to
  avoid colliding with Saransh's `006_engagement_disposition_followup.sql` (both had been "006").
  **Deploy state:** migrations **005 + 007** and the one-time dead/FU cleanups are **applied to the prod DB**;
  the backend code (`sheet_sync.py`, `main.py`, `seed_snapshot.py`) and **all** frontend changes still need a
  deploy (Render push + owner-token `vercel deploy`). Until then, prod runs old code over the new DB.
- **2026-06-09 (Claude session, cont. — frontend only, NOT yet deployed):**
  **(F) Date format standardised to dd/mm/yyyy across the app.** Root cause of "Windows shows mm/dd, Mac
  shows dd/mm": every formatter used `toLocaleDateString('en-IN', …)`, and the day-vs-month *order* is
  locale-decided — Windows without full `en-IN` data fell back to US (month-first). `lib/format.js`
  `fmtDate`/`fmtDateTime` are now **built manually** (no `toLocale*`) → identical dd/mm/yyyy on every OS;
  added `fmtMonth`/`MONTHS`. Replaced all locale date calls in `SnapshotView` + `BrokerModal`. (Remaining
  `toLocaleString('en-IN')` are number/₹ grouping only — not the date bug.) **Caveat:** native
  `<input type="date">` / `datetime-local` pickers (Filters date range, Next-FU, revisit/negotiation) render
  in the **OS locale** and can't be overridden by the app — that's a browser limitation, not our code.
  **(G) Home: live "Gold + Silver visits this month" counter** — a hero banner with an easeOutCubic count-up
  (`CountUp`), a pulsing ● LIVE badge and a moving shimmer (`.home-hero` in `app.css`). Counts current-month
  visits whose CP is tier T1/T2, with a Gold/Silver split; scoped per viewer (Admin = org-wide; e.g. June
  2026 = 236 → Gold 152 + Silver 84). **Deploy: frontend only (`vercel deploy`).**
- **2026-06-09 (Claude session, cont. — "Anuj Kumar sees nothing" fix; DB updated):** Root cause = the
  inventory sheet records some PMs by **first name only** ("Anuj") but everything matched on **full name**
  ("Anuj Kumar"), so a Ground PM with no full-name rows saw 0 visits / 0 properties. Two-part fix:
  **(1) Scoping** — `seed_snapshot.scope_for_user` (Ground branch) and frontend `scopeVisits` now match a PM's
  visits/properties by **full name OR first name** (`_is_pm` / `isPm`). **(2) Assignment** —
  `sheet_sync.sync_properties` PM lookup now resolves `sales_manager` by full name, falling back to a
  **first name only when it's unambiguous** (exactly one user), via an in-memory resolver built once per run
  (replaces the per-row exact-name `fetchrow`). Ran `sync_properties` against prod: `pm_changes=11`, Anuj now
  holds **6 active `property_assignments`** (Highend Paradise A-208/A-808, Ascent Savy Ville De C-810, Uninav
  Heights E-1206A, KW Srishti E-905, AR Reflections T-1104); scoped seed → **32 visits · 6 properties**.
  Note: assignment rows are now in the prod DB, so **even the currently-deployed (old) code scopes Anuj
  correctly** (it reads `pm_by_property`), and the old cron won't revert them (unresolvable first names are
  skipped, not cleared). Deploying `seed_snapshot.py` + `sheet_sync.py` makes first-name resolution durable
  going forward + gives full RM-visit coverage. Safety: "Anuj" → exactly 1 user (no collision); the resolver
  refuses ambiguous first names.
- **2026-06-09 (Claude session, cont. — "You don't have permission to edit this visit" 403):** A Ground RM
  (e.g. Vinay Kumar) could SEE a visit they ran but got a 403 on save, because `_can_edit_visit`
  (`main.py`) allowed only Admin/TL, the CP owner, or a Ground PM whose assigned property matched the
  society — it never allowed the **RM who actually ran the visit**. We had extended *viewing* to RM-run
  visits but not *editing*. Fix: `_can_edit_visit` now also returns true when the visit's `sales_manager`
  matches the user's **full or first name** (99 visits are recorded RM-by-first-name). Frontend
  `PropertyModal` `canEdit` updated to mirror it (adds `isMyVisit`; first-name aware for property + visit).
  **Deploy: this is a CODE permission change — needs the Render backend deploy to take effect** (unlike the
  Anuj assignment, it can't work on old code). Frontend `vercel deploy` for the PropertyModal parity.
- **2026-06-09 (Claude session, cont. — "phone saves but is blank on reopen"):** Editing a team-member's
  phone in UserModal showed "saved" but the field was empty next time. Cause: the **save persisted fine**
  (`/api/users` POST + PATCH both write `users.phone`), but the **seed's users query omitted `phone`**
  (`seed_snapshot.py` ~line 553 `SELECT slug,email,name,team,role,cities,active` — no phone), so the user
  object handed to the modal never carried it. Fix: add `phone` to that SELECT + the user projection.
  Verified: 4 users (Adiksha, Ajitesh, Mayank Chauhan, Mukul) already had phones sitting in the DB — they'll
  now show. **Backend-only; needs the Render deploy** (data was never lost). No frontend change.
- **2026-06-09 (Claude session, cont. — PHONE as the join key, not names):** Names are unreliable (spelling,
  first-vs-full), so PM matching now keys on **phone**. `sheet_sync.sync_properties` resolves a property's PM
  by `sales_manager_contact` (last-10-digits → `users.phone`) FIRST, falling back to full / unambiguous-first
  name only when there's no phone hit. Verified: the inventory PM phones match users **19/19**; re-running
  gave `pm_changes=0` (phone agrees with the already-correct names — no breakage) and **0 properties left
  unresolved**; Anuj's 6 intact. `users.phone` is now 27/36 active users (Saransh updated them). **Limitation:
  the visitors sheet has NO RM-phone column** (a visit only has `sales_manager` *name*: cols are
  sales_manager / broker_contact / broker_alt_contact / buyer_contact), so **visit-RM** matching (Ground
  PM seeing visits they ran + the edit-permission check) still uses name (full/first). To make visits phone-
  keyed too, add a `sales_manager_contact` column to the `visitors_data` sheet and mirror this resolver in
  `sync_visits`. **Deploy `sheet_sync.py` to Render** so the cron keeps using phone (assignment rows already
  in the DB work on current prod via `pm_by_property`; a name/phone conflict could otherwise be reverted by
  the old cron — none exist today).
- **2026-06-09 (Claude session, cont. — chip bubble counts ignored the Filters tab):** The Visits chip-bar
  counts (Buyer Status / Stage / Follow-up-due / Priority) were computed from `cityBase`, which only applied
  the city tab + lead-set — the **Filters-modal predicates** (society/unit/locality/BHK/tier/CP/RM/source/
  date-range/next-FU) and the **search** were applied only in the final `filtered` row list. So with a
  Filters-tab filter active the bubbles showed unfiltered totals (e.g. Status All = 1742) while the list
  showed the filtered count (801). Fix: moved the modal predicates + search INTO `cityBase`, so every bubble
  and the row list share one base and the counts match. The internal facet cascade (status→stage→FU→priority)
  is unchanged. `VisitsView.jsx` only; **frontend deploy**.
- **2026-06-09 (Claude session, cont. — Ready units wrongly marked Old/Dead):** VST9018 (B-304 Bestech Park
  View Ananda, a **Ready** unit) showed up under Old Leads + Dead. Cause: the two inventory tabs assign
  **different `home_id`s to the same unit**, and visits' home_ids align with the LIVE `properties` tab — but
  `sync_inactive_leads` joined only `all_properties` (where that unit is hid 112 / Archived, vs properties
  hid 130 / Ready), so the hid-130 visits found no match → wrongly classified inactive. **69 visits** (all on
  B-304 Ananda) were affected. Fix: `sync_inactive_leads` now treats a visit ACTIVE if its home_id is
  Ready/Coming-Soon in **`properties` OR `all_properties`** (prefer live). One-time DB repair restored the 69
  (30 worked → re-projected from their latest followup; 39 unworked → reset to Not-Updated; all
  `is_old_lead=FALSE`); the fixed reclassify then returned `reclassified=0` (consistent). **Needs the Render
  deploy** — the currently-deployed (all_properties-only) `sync_inactive_leads` will re-archive these 69 on
  its next 15-min cron run until the fix ships.
- **2026-06-13 (Claude session — Visits filter split + stage-aware follow-up buckets; edit-permission audit):**
  Three reported issues; **two shipped to prod, one validated as a non-issue.**
  **(1) Two-tier Visits filter (#1 — DEPLOYED, `VisitsView.jsx`):** the single "Visit stage · operational
  pipeline" chip-bar mixed the visit *lifecycle* (Completed / Upcoming / Cancelled) with the *pipeline
  sub-stages* (After Visit FU, Revisit Scheduled, …) in one flat, confusing row. Split into two bars —
  **Visit status** (`__completed`/upcoming/cancelled) + **Pipeline stage** (the 10 sub-stages) — both driving
  the same `stages` selection via the unchanged `stagePass`, so filtering/counts are identical (purely
  presentational).
  **(2) Stage-aware follow-up buckets (#2 — DEPLOYED, `lib/visits.js`):** "Overdue" was counting terminal
  leads. Root cause: the FU gate keyed only on buyer-status `dead` (`nextFuFor`/`matchFuFilter`), ignoring the
  operational *stage* — so **Future Prospect** (status≠dead) and **Not Interested** with a non-dead status
  leaked into Overdue, while **Need More Props** marked dead was excluded from *every* bucket (incl. "No
  next-FU set") and so never prompted for a date. Added `TERMINAL_STAGES = {future_prospect, not_interested}`
  + an `isClosedLead(v)` helper (terminal stage OR dead-but-not-need_more) used by `nextFuFor`,
  `matchFuFilter`, and `activityForVisit`. Validated old-vs-new over the **live** DB: **only**
  `future_prospect`/`not_interested`/`need_more` ever change bucket (every other stage byte-identical) —
  Overdue 364→292 (removes 55 Not-Interested + 17 Future-Prospect, adds 0); ~59 dead Need-More leads now
  surface under "No next-FU set". (A Need-More lead still carries buyer-status `dead` in the DB, so to set a
  date the rep re-classifies it to an active status — the form disables the date while `dead`.)
  **(3) "Mayank can't edit, Abhash can" (#3 — AUDITED, NO CODE CHANGE):** deep validation of `_can_edit_visit`
  (`main.py`) vs `scope_for_user` reproduced both over all 36 users and found **see ⟹ edit already holds —
  0 gaps**; live-confirmed (minted cookie) that Mayank's seed = **620 visits, all 620 editable**. Mayank is a
  **KAM** (scope = own CPs only); Abhash is **Ground** (PM of his societies + RM on his visits). The leads
  Mayank "can't edit" (e.g. Arihant Abode visits run by Abhash) are **outside his visibility**, not an edit
  gap — and visibility was explicitly left as-is. The one structural change that *would* do anything
  (assignment-based edit for all teams, i.e. dropping the `team=='Ground'` gate on the property-PM path) would
  grant edit on **unseen** leads to 2 KAM-PMs (Mayank +17, Shubham +67) — broadening permission beyond
  visibility — so it was **not** made. Open: if PM-KAMs should *work* their assigned property's leads, that's
  a scoped **visibility** tweak (awaiting a concrete failing VST… to confirm the surface). Latent (untouched):
  `BrokerModal` visit rows render Save with no `canEdit` gate, so a denied save would surface as a "Save
  failed: …403" toast rather than read-only — doesn't bite KAMs on their own CPs today.
  **Deploy:** frontend shipped via owner `vercel deploy --prod` (CLI already auth'd as `akshit-1522`); live
  bundle `index-BiUbRIdY.js` is **SHA-256 byte-identical** to the locally unit-tested build (6/6 logic tests +
  render-smoke, 0 console errors). Backend unchanged. Validated L1/L2/L3.

---

## 10. Pending / TODO
1. **Analytics "View in Google Sheets"** export — needs a backend endpoint (service account writes a Sheet from the filtered rows) + buyer-PII sign-off.
2. **Connect `akshit-openhouse` GitHub to the Vercel team** so frontend deploys aren't owner-token-only.
3. **Rotate the Vercel deploy token** — the one reused on 2026-06-08 is akshit's personal token and is sitting
   in old Claude session transcripts. Create a fresh one (Vercel → Settings → Tokens), deploy with it, revoke the old.
4. **Verify the `cp_reassign_2026_06`** result matches intent (the New Demand Flow sheet had ~1,267 "Unassigned" + new-hire placeholders).
5. Delete the stray `backend/api/import_top_brokers 2.py`.
6. (Optional) rotate the Neon password — it's in early git history.
7. (Optional) broader CP write-back to LSQ (all ~4,681 CPs vs the 1,248 active).
8. **"My Follow-ups" view** (Overdue / Today / Upcoming buckets + optional daily digest) to surface the
   engagement follow-up dates now captured via migration 006. Research-backed (Pipedrive/Zoho pattern); not built yet.
9. (Optional, from the 2026-06-08 best-CRM research) **revisit-as-chain** (`original_visit_id` self-FK for a
   linked visit sequence) and a Google Drive **`changes.watch` webhook + optimistic writes** to cut the 15-min
   sheet-sync lag for app-entered activity.

---

## 11. Common commands
```bash
# DB spot-check (read-only)        — see §4.1
# Test as a user / inspect seed     — see §4.2-4.3
cd frontend && npm install && npm run build         # build frontend
npx vercel deploy --prod --token=<owner token>      # deploy frontend (from repo root, .vercel/project.json present)
git push origin main                                # deploy backend (Render auto)
curl https://openhouse-demand-crm.vercel.app/health # API health via proxy
curl -X POST -H "X-Internal-Cron-Token: $INTERNAL_CRON_TOKEN" \
  https://oh-demand-crm-api.onrender.com/admin/sync # trigger sheet sync
```

---

## 12. Doc index
`HANDOVER_LATEST.md` (this — start here) · `BACKEND_SCHEMA.md` (full DDL) ·
`SESSION_HANDOVER_2026-06.md` + `PROD_HANDOVER.md` (history) · `LSQ_HANDOVER.md` +
`lsq_sync/README.md` (LSQ migration) · `DEPLOY_RUNBOOK.md` (first-time deploy) ·
`HANDOVER.md` / `SARANSH_HANDOVER.md` (original pre-React design) · `FINDINGS.md`.
