# OpenHouse Demand CRM — Handover (LATEST · 2026-06-15)

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
│       ├── views/            HomeView (default landing), VisitsView, CpView, PropertiesView, TeamView,
│       │                     NotificationsView, SnapshotView, AnalyticsView, BookVisitsView (super-admin booking · beta),
│       │                     HiringView (admin hiring/MM planning · beta), ReportShareView (admin seller-report mailer · beta),
│       │                     AiSuggestionsView (per-user daily AI morning brief · all roles · beta)
│       ├── components/       BrokerModal, PropertyModal, UserModal, FiltersModal, BottomTabBar (mobile nav), …
│       ├── lib/              visits.js (stage/status/scope), analytics.js, legacy.js, …
│       ├── app.css / theme.css   light theme; tokens in theme.css (:root)
├── backend/                  FastAPI (Render root = backend/)
│   ├── api/
│   │   ├── main.py           all routes (read seed + writes + OAuth + admin sync)
│   │   ├── auth.py           Google OAuth + signed session cookie (SameSite=Lax)
│   │   ├── seed_snapshot.py  build() the /api/seed payload + scope_for_user() per role
│   │   ├── reports.py        Property Report mailer: metrics (by home_id) + Claude(Sonnet) feedback summary + branded HTML + Gmail draft (SA domain-wide delegation)
│   │   ├── ai_suggestions.py Per-user daily AI "morning brief": deterministic signals from SCOPED visits (near-closing, overdue FUs, broker call-nudges) + Claude(Sonnet) prioritisation. Reuses scope_for_user.
│   │   ├── sheet_sync.py     Sheets → Postgres upsert (brokers/visits/inventory)
│   │   ├── import_ct_assignments.py   one-off CP owner/tier import from CT sheet
│   │   ├── import_top_brokers.py      99acres top-brokers import
│   │   ├── bootstrap.py      one-shot schema + users + first sync
│   │   ├── db.py / config.py / sheets.py
│   │   └── migrations/ 001…016 (latest: 014 kh_overrides · 015 user_core_sales_manager_id [renumbered from a dup 008] · 016 team_perf_manual)
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
0. **If it adds/changes a DB column (migration):** write `backend/migrations/NNN_*.sql` — idempotent
   (`ADD COLUMN IF NOT EXISTS`) — and **apply it to prod FIRST, before the code deploy** (the new code's
   `SELECT`s error on a missing column → CRM down). Apply with a read-WRITE psycopg2 connection (the §4.0 env,
   NOT `set_session(readonly)`): `cur.execute(open(path).read()); conn.commit()`, then verify via
   `information_schema.columns`. There is **no auto-runner** — migrations are applied by hand (migration 010 was
   applied this way on 2026-06-14). If `scope_for_user`/handlers read the new column, add it to **both `auth.py`
   user `SELECT`s** too (that dict is what `scope_for_user` receives).
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
  Three opt-in extensions (all default to nobody → no one affected unless set):
  - **MM-managers** — a user with `users.micro_markets` set (usually TLs) sees every property+visit in those
    micro-markets, overriding team/city (migration 008).
  - **KAM extra-cities** — a KAM with `users.extra_cities` + `extra_cities_enabled` also sees (and edits) ALL
    visits in those cities, on top of their own CPs (migration 010; admin toggle in the User modal). Live:
    Saket → Noida+Ghaziabad, Mukul → Gurgaon.
  - **No-KAM cities** — `NO_KAM_GROUND_CITIES` (a code constant in `seed_snapshot.py`, mirrored in
    `lib/visits.js` + `lib/brokers.js`) = **`{Ghaziabad}`**. In a city with no KAM structure, every **Ground**
    PM whose `cities` include it sees **every lead and every CP (all tiers, not just T3/T4)** in that city, not
    just their assigned societies — there's no KAM to own the channel partners. Gated on `cities ∩
    NO_KAM_GROUND_CITIES`, so it is a **no-op for every non-Ghaziabad user** (and for KAMs/TL/Admin). It grants
    *visibility* only — edit rights are unchanged (the city has no KAM, so its CPs were already Ground-owned in
    practice). To onboard another KAM-less city, add it to the set in all three files and redeploy both.
  **Edit permission** (`_can_edit_visit()` in `main.py`, mirrored by `canEdit` in `PropertyModal`) is a
  deliberate MIRROR of visibility — **see ⟹ edit** for every role: Admin/TL, CP owner, the RM who ran the
  visit, a Ground PM at_my_property, a KAM with the extra-city grant, a Ground PM in a **no-KAM city**, and
  **micro-market managers**. It keys on the SAME inventory-corrected city the seed uses (home_id→inventory;
  raw `visits.city` is sometimes mis-entered) — a drift here was the 2026-06-20 "can't edit a lead I can
  see" bug (§9). If you extend `scope_for_user`, extend `_can_edit_visit` + `canEdit` in lock-step.
  **Lesson learned:** scope by the *assignment tables* (slug), not by matching sheet name-text to a
  user's full name (sheets store some PMs by first name → silent zero-results; see §8).

---

## 6. API endpoints (`backend/api/main.py`)
Read: `GET /api/me`, `GET /api/seed`, `GET /api/top-brokers`, `GET /api/hiring` (**admin** — hiring table),
`GET /api/ai-suggestions` (**all roles** — the caller's daily AI brief; generates + caches on-demand if today's is missing).
Writes (all persisted, permission-checked): `POST /api/followups`, `/api/nudges`,
`/api/notifications/{id}/read`, `/api/notifications/read_all`, `/api/daily_tasks/pin|unpin`,
`/api/engagements`, `/api/brokers/{cp}/tier`, `/api/brokers/{cp}/owner`, `/api/brokers/bulk_assign`,
`/api/visits/bulk_reassign`, `POST /api/users` + `PATCH /api/users/{slug}` (admin),
`/api/top-brokers/{id}/phone`, `POST /api/hiring/mm-override` (**admin** — fills a blank MM),
`POST /api/reports/property` (**admin** — build a seller report: metrics + Claude summary + rendered HTML; read-only),
`POST /api/reports/property/draft` (**admin** — save that report as a Gmail **draft** in the caller's own mailbox; `503` until SA delegation is enabled),
`POST /api/ai-suggestions/refresh` (**admin only** — force-regenerate the caller's own brief; gated because it triggers an expensive full-snapshot regen. The button is hidden for non-admins in the view too),
`POST /api/kh-override` (**admin only** — set/clear a unit's key-handover date in the Property Status report, persisted to `kh_overrides` by `home_id`; wins over the matched date. `GET /api/key-handovers` also returns these `overrides`),
`GET|POST /api/team-performance/manual` (**admin only** — read / set-clear the hand-entered Team Performance cells, persisted to `team_perf_manual` by (person, metric). Backend-computed columns are never written here, so they stay read-only).
Auth: `/auth/google/start|callback`, `/auth/logout`,
`/auth/dev_login` (only when `DEV_MODE=1`). Ops: `POST /admin/sync`, `POST /admin/generate-suggestions` (daily 09:30-IST cron, token-gated — pre-generates every user's brief), `GET /health`.

---

## 7. Frontend features (`frontend/src/views/`)
Visits · Channel Partners · Properties · **Analytics** · To Be Assigned (admin) ·
Inventory Snapshot · Team/My Day · Notifications · **Book Visits** (super-admins only · beta) ·
**Hiring** (admins · beta) · **Report Share** (admins · beta). Modals: Broker, Property, User (add/edit), Filters.
Admin "impersonation" switcher re-scopes every view to view-as-another-user.

**Analytics tab** (`AnalyticsView.jsx` + `lib/analytics.js`): 11 filters (Status default Completed),
8 dependency-free SVG charts + a filtered raw table with CSV download, all cross-filtering on click.
Apartment = `addr2 · addr1 · society`. "View in Google Sheets" is stubbed (fast-follow).

**Mobile (≤900px, 2026-06-14 — all mobile-only, desktop byte-identical):** a **bottom tab bar**
(`components/BottomTabBar.jsx`) replaces the sidebar; Visits/CPs/Properties/Snapshot use card layouts (via
`useIsMobile`); Analytics shows a compact 4-col raw table; 16px inputs (no iOS zoom); the CP filter list is
typed/capped (no 4,000-`<option>` freeze). Pending mobile polish: modal sticky-close + density (see §10).

**Admin User modal** (`UserModal.jsx`): add/edit roster members + per-user `cities`, **Micro-market manager**
(`micro_markets`), and — for KAMs — **Extra-city visit access** (a toggle + cities chip-input → `extra_cities`
/ `extra_cities_enabled`). All persist via `POST`/`PATCH /api/users`.

**Book Visits tab** (`BookVisitsView.jsx`, **super-admins only · beta**, 2026-06-15): schedule app visits from the
CRM — single or **up to 10** at once. Gated by **exact slug** `SUPER_ADMINS = {akshit, saransh}` in `App.jsx` on
the **real** signed-in user (NOT team/role — other users are also Admin/admin; NOT the impersonated `me`). Reads
live inventory (`seed.properties`, Ready/Coming-Soon with a `home_id`) + CPs (`seed.brokers`, `broker_id = b.id =
core external_id`); a detailed confirm step lists every field with a **"cannot be edited or undone"** warning. The
view is self-contained (styles scoped under `bv-`, no `app.css` change) and currently **PREVIEW-ONLY**:
**`BOOKING_LIVE = false`** at the top of the file → Confirm writes nothing / calls nothing. To go live: flip that
flag and add the server call to the new app-backend endpoint specced in **`docs/APP_BACKEND_BOOKING_API_SPEC.md`**
(takes ≤10 visits at once, creates them **sequentially** via the existing single-create path; `X-CRM-Key` +
`created_by` phone/email → SalesManager). Roll out beyond the two super-admins by adding slugs to `SUPER_ADMINS`.

**Hiring tab** (`HiringView.jsx`, **admins only · beta**, 2026-06-15): a city × micro-market planning table —
property bifurcation (Ready / Coming Soon / Archived) → Total + **currently-assigned PM count**, off
`all_properties` (so it includes Archived, which the seed doesn't). Backed by **`GET /api/hiring`** (admin-gated
aggregation) — NOT the seed. Admins can **fill the micro-market** for blank-MM societies (mostly Archived); the
fill is stored in **`hiring_mm_overrides`** (migration 012) and applied ONLY as a COALESCE fallback (`POST
/api/hiring/mm-override`), so a unit's real sheet MM always wins and it never mutates `all_properties`. Gated in
`App.jsx` by `adminOnly` → `me.team === 'Admin'` (the 8 Admin-team users incl. super-admins). Self-contained view
(styles scoped under `hr-`, no `app.css` change). PM count = distinct PMs with a current `property_assignments`
row in that MM (authoritative; per-MM, so totals don't sum them).

**Report Share tab** (`ReportShareView.jsx` + `backend/api/reports.py`, **admins only · beta**, 2026-06-15): generate a
seller-facing **property performance report** and save it as a **draft in the triggering admin's own Gmail** (they add the
recipient and send — nothing is emailed automatically). Pick a property (any live unit with a `home_id`) → `POST
/api/reports/property` builds it server-side and returns metrics + an optional Claude summary + the rendered HTML, shown in a
sandboxed iframe preview → "Create Gmail draft" calls `POST /api/reports/property/draft`. **Metrics are keyed on `home_id`**, so
they reconcile EXACTLY with the Analytics "Property Status" tab (`visitsForProperty`): visits last-7-days, visits-to-date,
unique buyers, monthly trend, and a Hot/Warm/Cold/Dead/Not-updated pipeline. The **feedback summary** uses **Claude Sonnet**
(`claude-sonnet-4-6`, forced tool-use → structured {headline, positives, objections, notable_leads, assessment,
recommendations}); it **degrades gracefully** — no `ANTHROPIC_API_KEY` or no feedback → the report still renders, metrics-only.
The **Gmail draft** is created via **service-account domain-wide delegation** (`subject=<caller email>`, `gmail.compose` scope,
**draft only, never send**). Gated in `App.jsx` by `adminOnly` → `me.team === 'Admin'` AND server-side `_require_admin`.
Self-contained view (styles scoped under `rp-`, no `app.css` change); `anthropic` is **lazily imported** so the app boots even
if the SDK/key is absent. **Two prerequisites before the draft button works** (see §10): (a) `ANTHROPIC_API_KEY` in Render's
`oh-crm-secrets`; (b) Workspace admin authorises the SA client_id `103924240682962245131` for the `gmail.compose` scope. Until
(b), the draft endpoint returns a friendly **`503`** and the UI shows the actionable message; the preview/metrics work regardless.

**AI Suggestions tab** (`AiSuggestionsView.jsx` + `backend/api/ai_suggestions.py`, **ALL roles · beta**, 2026-06-16): a per-user
daily **"morning brief"** — placed second in the nav (after Home). For each user it (1) scopes the snapshot via **`scope_for_user`**
(identical who-sees-what, so it only reflects their own book), (2) computes deterministic **signals** from their scoped visits —
leads **near closing** (advanced stages), **overdue / due-today** follow-ups, **channel-partners to call** (with pending counts +
buyer names), **awaiting-status-update** counts — using a Python port of `lib/visits.js` (visitStage/nextFu/isClosedLead), then
(3) asks **Claude Sonnet** to PRIORITISE + phrase them into an **uncapped, priority-ordered** list. Each point is **clickable**:
`link_kind` ∈ {broker → opens the CP modal, lead → jumps to Visits filtered to that buyer, visits, none}; the frontend validates
broker cp_codes against the user's own brokers so a click can't break (App.jsx gained a `pendingSearch` ref so the deep-link search
survives the view switch — otherwise byte-identical). Role-aware framing: KAM=their CPs, PM=their properties, TL=their market/team,
Admin=org-wide. Cached one row per user per day in **`ai_suggestions`** (migration 013). Generated **on-demand** on first open
(`GET /api/ai-suggestions`) AND pre-generated for everyone by a **09:30-IST cron** that runs the batch **in its own cron
container** (`python -m api.generate_suggestions_cli`, in `render.yaml`) — deliberately NOT via the web service, because the
full-snapshot build is a few minutes of CPU (~285s for 38 users on starter) and must not degrade the live app at the login peak.
`POST /admin/generate-suggestions` is the equivalent **manual** web trigger (token-gated; loads the web service, use sparingly).
⚠ On-demand (cold) generation is slow (~50s — builds the full snapshot like `/api/seed`); the cron keeps morning opens cached &
instant. Adding the cron needs a Render **Blueprint re-sync** (a git push won't create a new service). Degrades gracefully: no
key / API error → a deterministic (still clickable) fallback brief. Self-contained (styles scoped `as-`, no `app.css` change); `anthropic` lazy-imported.

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
- **2026-06-27 (Claude session — per-tab filter persistence + Reset, PR #44):**
  - Every tab now **remembers the filters it applied for the session** (persists across tab navigation;
    resets on page refresh / closing the link), plus an obvious **"↺ Reset filters"** in each tab. Web + mobile.
  - **New `lib/sessionFilters.js`**: module-level `Map` + `useStickyState(key, initial)` drop-in for useState.
    In-memory ONLY (deliberately NOT local/sessionStorage, which survive refresh) → survives SPA tab switches,
    wiped on a full reload. Each filtered view (Negotiations / Revisits / Channel Partners / Properties /
    Analytics / Inventory Snapshot / Property Performance / Book Visits) swaps filter `useState`→`useStickyState('<view>:<field>',…)`.
    Visits already persisted via `visitsUi`; the shared top-bar Filters already persisted app-level (both unchanged).
  - `App.jsx`: **search is now remembered per tab** (save-outgoing / restore-incoming via the store), preserving
    the AI-Suggestions deep-link; two reset callbacks (`resetSearch`, `resetGlobalFilters`) handed to views. Each
    tab's Reset clears its own chips/dates/sort + (where applicable) the shared Filters + search. New
    `.btn.rx-reset-filters` style in app.css. Frontend-only, in-memory; no backend/DB/data change.
  - Live-validated (web 1280px + mobile 375px, Admin): persistence + per-tab search + Reset + reset-on-refresh
    (nothing persisted to disk) + deep-link intact + no console errors. Admin-only TeamPerf/ReportShare left out.
- **2026-06-27 (Claude session — mobile polish: broker-modal tabs + chip-fade, PR #43):**
  - Follow-up to #42, two mobile-only polish fixes (desktop byte-identical). (1) `BrokerModal.jsx`: the modal
    rendered TWO tab rows on phones — the mobile `.bp-mtoggle` (Visits/Engagement/Timeline/Info) AND the desktop
    "MAIN TAB BAR" (with counts), both driving `popupTab`. Gated the main tab bar to `!isMobile` → phones get the
    single `.bp-mtoggle` row. (2) `theme.css` mobile `.chip-row`: added a right-edge `mask-image` fade so the
    horizontally-scrolling filter chips (scrollbar hidden) show there's more to scroll.
  - Live-validated at 375px as **Admin, Ground PM (`abhash`), and KAM (`mukul`)**: modal now one tab row + 375px
    wide; chip fade visible on scrollable rows; page overflow 0 on every view; scoped data correct (KAM = own
    T1/T2 only, 1 negotiation lead vs Admin's 55). Frontend-only; Vercel auto-deploy.
- **2026-06-27 (Claude session — mobile top-bar overflow fix, PR #42):**
  - Full mobile audit (live, at 375px). Finding: the CRM is already solid on mobile except **one** real defect —
    on the search views (Visits / Negotiations / Channel Partners / Properties) the top bar (logo wordmark +
    search + Filters + user switcher) is wider than a phone, giving **44–124px of horizontal page overflow**
    (sideways drift; the signed-in user's name wrapped to 3 lines or was pushed off-screen; full-screen modals
    stretched to ~419px). Non-search views were already 0 (no search box).
  - **`app.css`** (existing `@media (max-width:760px)` top-bar block): hide the redundant top-bar TEXT on phones —
    `.rx-brand > span` (the "OpenHouse DEMAND" wordmark) and `.rx-who > span:first-child` (the user's own
    "Name · Team"). The logo icon + tappable avatar/▾ switcher stay → no function lost. CSS-only, ≤760px,
    **desktop byte-identical**.
  - Live-validated at 375px: overflow **124 → 0** (Visits), **44 → 0** (Channel Partners); avatar switcher still
    opens the 48-user "view as" list; Home / Book Visits / Property Performance unchanged; broker modal back to
    375px. Frontend-only; Vercel auto-deploy. Verified-solid & unchanged: Negotiations/Revisits day-of confirm +
    reschedule (`datetime-local` fits), wide tables scroll inside `.ps-wrap`, broker modal opens fast (no freeze).
- **2026-06-25 (Claude session — Negotiations tab: KAMs scoped to their own T1/T2, PR #35):**
  - In the Negotiations tab a KAM should see **only their own (T1/T2) CP leads**, not the wider extra-cities
    pipeline ("everyone's pipeline should not be available to everyone"). The tab reused Visits' scoping, where a
    KAM with `extra_cities_enabled` also sees every visit in their **extra cities** — i.e. other reps' entire
    pipeline. All 4 active KAMs have the flag on, so most of what they saw in Negotiations was others' leads.
  - **`NegotiationsView.jsx`** — one additive, gated post-filter on the existing `scoped` memo:
    `me.team === 'KAM' ? v.filter(x => cpOwner[x.cp_code] === me.id) : v`. `cpOwner[cp] === me.id` is the **exact**
    owned-CP predicate already used for KAMs in `scopeVisits` (`lib/visits.js`), minus the extra_cities branch.
    Gated on `team === 'KAM'` → Admin / TL / Ground / MM-manager **byte-identical**; **Visits tab, backend & DB
    untouched** (display-layer only — the extra-city leads still arrive in the seed because Visits needs them).
  - Live-validated (read-only; server `scope_for_user` → `scopeVisits` → new filter, all 4 KAMs): owned CPs are
    **100% T1/T2**; remaining tiers = `{T1,T2}`, **0 non-owned leakage, 0 owned-lead loss**. Negotiation-funnel
    leads removed (others' pipeline) per KAM: Mayank 15, Mukul 45, Saket 25, Shubham 18. Frontend-only; Vercel auto-deploy.
- **2026-06-22 (Claude session — "To action" refined to the actionable queue, PR #31):**
  - Follow-up to PR #30. User reported the "🎯 To action" badge (~2505) didn't match the manual filter he applies
    (~768). Root-caused on live data: **not a bug** — PR #30's preset was literally "all completed · CP · 45d",
    while his manual filter additionally selected buyer status Hot/Warm/Cold + follow-up {Overdue, Due Today,
    No-next-FU} (305+58+405 = 768 exactly). Per his call, **also include Not-Updated leads**.
  - **New `isToAction`** (`VisitsView.jsx`): completed · `channel_partner` · visit_date∈[today-45,today] · buyer
    status ∈ **{hot, warm, cold, unc}** (Dead/Future-Prospect excluded) · next-FU is **Overdue OR Due-Today OR
    not-set** (`matchFuFilter` already enforces completed+not-closed). Due-Tomorrow/This-Week excluded.
  - Two added clauses on the existing predicate; sole consumers are the badge count + `actionMode` in `filtered`.
    Live-validated: **1156** (overdue 322 + today 61 + no-FU 773), statuses limited to hot/warm/cold/unc, 0
    dead/future/direct/out-of-window/tomorrow-only leakage. Frontend-only; bundle `index-Dsb6YU7X.js` live.
- **2026-06-22 (Claude session — Hiring count fix + Visits "To action" preset, PRs #29, #30):**
  - **Hiring "To hire"** (PR #29, `main.py` get_hiring): now `ceil(total / 5) − existing PMs` over **ALL**
    properties (Ready + Coming Soon + **Archived**), not just active — e.g. 47 props → 10 required, 5 PMs → 5 to
    hire. Was active-only. One-line change; live total to_hire 5 → 19.
  - **Visits "🎯 To action" preset** (PR #30, `VisitsView.jsx`): new one-click chip in the Priority row =
    completed visits · source `channel_partner` · visit_date in [today-45, today]. When selected it REPLACES the
    buyer/visit-status/pipeline/follow-up chips (the city/lead-set/Filters base still applies) via an `actionMode`
    branch in `filtered`; toggling off restores the prior chips. Additive — only VisitsView; predicate +
    override unit-validated.
- **2026-06-22 (Claude session — Hiring overhaul + Property Performance tab, PRs #27, #28):**
  - **Hiring** (PR #27, `main.py` `get_hiring` + `HiringView.jsx`): the "Fill missing micro-markets" rows now
    show the society's **locality** (`all_properties.locality_or_sector`); each blank gets a **suggested MM**
    (suggest-only, pre-filled for review + Save — the society's own MM on a non-blank unit, else the most common
    MM among same-locality societies); **stale archived** units (Archived AND created >2 weeks ago) are dropped
    from the list (live 22→11); and a new **"To hire"** column on the per-MM table = `ceil(active ÷ 5) − existing
    PMs` (1 PM per 5 Ready+Coming-Soon properties), additive across MMs.
  - **Property Performance** (PR #28, new `PropertyPerformanceView.jsx` + `PropertyStatusTable.jsx` +
    `AnalyticsView.jsx` + `App.jsx`): the Property Status report **moved out of Analytics** into its own
    top-level tab (visible to **everyone** — same audience as Analytics) with a full filter bar — City · Region ·
    Flat status · Config · Society (contains) · Responsible · Ask-price range (₹ Cr) · **Days-since-KH 30-day
    buckets** (0–30/31–60/61–90/90+/No KH). `PropertyStatusTable` filtering extended to every dimension
    (additive — empty = no-op; price via `parsePrice`, bucket via shared `khBucketOf()`). The table, KH editing,
    CSV and Sheets link are unchanged; Analytics keeps its other charts. Frontend-only; SSR + filter-predicate
    validated; no global CSS touched.
- **2026-06-20 (Claude session — Book Visits: Booked inventory + full CP directory, PRs #23–#24):**
  - **Booked units** (PR #23, `BookVisitsView.jsx`): the inventory filter listed only Ready + Coming Soon;
    now shows **Ready + Coming Soon + Booked** (distinct neutral "Booked" badge; count row breaks out
    ready/coming-soon/booked). Sold/Archived stay hidden. Frontend-only; the seed already carries every
    `listing_status` (no status filter in `scope_for_user`), so booked units just appear within each viewer's
    existing property scope. Live: 101 Ready / 40 Coming Soon / 15 Booked (14 with a home_id → bookable).
  - **Full CP directory in the picker** (PR #24, new **`GET /api/cps`** + `BookVisitsView.jsx` + `api.js`):
    the booking CP picker only searched the viewer's SCOPED brokers (`seed.brokers` = own/added/T3-T4/visit-
    linked), so a CP outside scope (a KAM-owned T1/T2 with no synced visit at the RM's society) was unfindable.
    Vipul couldn't find "Manju" (CP01722, T1, owner shubham) because her only link to him was a not-yet-synced
    Tulip Orange visit; admins (all brokers) could. Now `BookVisitsView` loads the **full directory** (5341 CPs,
    minimal fields) from `/api/cps` (auth-required, read-only) and feeds it to the picker, **falling back to the
    scoped `seed.brokers`** until it loads / on error. Additive — only the Book Visits picker changes; every
    other view keeps the scoped brokers, no seed/scoping/data change. Live-verified: Vipul's `/api/cps` returns
    5341 CPs and the picker search matches "Manju" by both name and phone.
- **2026-06-20 (Claude session — edit-permission mirrors visibility, "see ⟹ edit", PR #22):** users hit
  *"You don't have permission to edit this visit"* on leads they could clearly see (Saket — KAM; Rajnish — had
  been made Admin as a workaround; and, post-PR #19, the Ghaziabad PMs). Root cause: `_can_edit_visit` /
  `PropertyModal.canEdit` had drifted from `scope_for_user`. Three drifts, one fix each: **(1) city** — the
  seed corrects a visit's city via the inventory mirror (`home_id → all_properties.city`; raw `visits.city` is
  often mis-entered, e.g. a Ghaziabad society tagged Noida/Gurgaon), but the edit check read the RAW city, so a
  KAM saw a lead via his extra-city (corrected) yet couldn't edit it (raw). The edit check now keys on the SAME
  corrected city. **(2) no-KAM city** — Ground PMs in Ghaziabad now also *edit* every city lead (PR #19 only
  gave visibility). **(3) MM-managers** (`Ground`+`micro_markets`, e.g. Ankit Jangir, Vikrant Sengar) now edit
  every lead in their micro-markets. Purely **additive** (no grant removed; edit only within visibility).
  Validated over all 40 active users on the live snapshot: see-but-can't-edit **13 → 0** users, 0 reachable
  edit lost, 0 new over-grant. Live spot-test: Saket's failing leads now editable; an out-of-scope Gurgaon lead
  and a Gurgaon PM on a Ghaziabad lead stay denied. Files: `main.py` `_can_edit_visit`, `PropertyModal.jsx`
  `canEdit`. **Lesson:** the prior "Rajnish made Admin" was a symptom-patch — fix the see/edit drift instead.
- **2026-06-20 (Claude session — Ghaziabad no-KAM city scope, PR #19):** Ghaziabad has **no KAM structure yet**,
  so its **Ground PMs must see every lead + every CP (all tiers, not just T3/T4)** in the city — not only their
  assigned societies. Introduced **`NO_KAM_GROUND_CITIES = {Ghaziabad}`** in `seed_snapshot.py` (`scope_for_user`,
  Ground branch), mirrored in `lib/visits.js` (`scopeVisits`) + `lib/brokers.js` (`ownedCpCodes`). Every added
  clause is gated on `cities ∩ NO_KAM_GROUND_CITIES`, **empty for all non-Ghaziabad users → byte-identical scope**.
  Validated vs the full prod snapshot (9,458 visits): **only the 7 Ghaziabad Ground PMs change** (Aditya, Ankush,
  Anuj, Atishay, Hashim, Manish, Sahil — each now sees 595/595 city visits + 563/563 city CPs); "non-Ghaziabad-Ground
  changed = NONE"; KAM **Saket (kept)**, other KAMs, non-Ghaziabad Ground, TL, Admin all byte-identical. Live
  cookie smoke test confirmed the PM's Ghaziabad view == admin's Ghaziabad view; controls unchanged. See §5 (3rd
  scoping extension). **To add another KAM-less city, extend the set in all three files + redeploy both.**
- **2026-06-19 (Claude session — Book Visits opened up + 3 mobile fixes, PRs #15–#18):**
  - **Book Visits → all users** (PR #15, `main.py` + `BookVisitsView.jsx`): removed `_require_admin` from
    `POST /api/visits/book`; the gate is now **`core_sales_manager_id`** (any RM mapped to a Core SalesManager can
    book; **422** if unmapped). The nav tab now shows for everyone (gated by `can_book_visits` in the seed).
    Dropped the per-visit-buyer toggle — bookings always use **one shared buyer** (option 2 wasn't supported). The
    **CP picker now shows company + 📞 phone** in the dropdown, selected value and search, so the RM picks the right CP.
  - **Mobile modal close** (PR #16, `BrokerModal.jsx` + `theme.css`): added a clear **✕ pinned top-right** (40px
    circle) on the CP/lead modal for ≤900px, hiding the easy-to-miss action-row close. Desktop untouched.
  - **Mobile Book Visits h-scroll** (PR #17): `.bv-tablecard{overflow-x:auto}` + `.bv-tbl{min-width:760px}` so the
    wide inventory table scrolls sideways instead of clipping.
  - **Mobile Book Visits cards** (PR #18, `BookVisitsView.jsx` + `useIsMobile`): on ≤900px the inventory renders as
    **one tappable card per unit** (checkbox + society + unit·cfg·sqft + MM·status + price + Book→) instead of the
    h-scroll table. `bv-` styles inline in the view so `app.css`/`theme.css` stay byte-unchanged.
- **2026-06-17 (Claude session — AI-suggestion filters · Visits filter memory · migration renumber · Team Performance, PRs #11–#14):**
  - **AI Suggestions** (PR #11, `ai_suggestions.py` + `seed_snapshot.py`): the daily brief now shows **only live-inventory
    units** — a lead is skipped when its unit is positively off-market (Sold/Booked/Archived per the `all_properties` mirror,
    joined by `home_id`; unknown unit → kept, never over-filters) — and **hides dead/dropped leads** (`is_closed_lead`:
    status Dead, or stage not-interested/future-prospect). A server-side `live_by_home_id` map is built in
    `seed_snapshot.build` and **popped in `get_seed`** so it never reaches the browser. Validated on the full prod dataset
    (all 41 users): no brief emptied; the live regenerated counts matched the local computation exactly.
  - **Visits filter memory** (PR #12, `App.jsx` + `VisitsView.jsx`): the chip-bar + sort selections are lifted into App as
    `visitsUi` so they survive the view unmounting on a tab switch — per-tab, in-session (resets on a hard reload). No CSS change.
  - **Migration renumber** (PR #13): Saransh's duplicate `008` booking migration → **015** (`user_core_sales_manager_id`);
    his edits verified byte-identical, sequence now `001…016` with no duplicate numbers.
  - **Team Performance** (PR #14, **migration 016** `team_perf_manual`, `views/TeamPerformanceView.jsx` + `lib/teamPerf.js`
    + `GET|POST /api/team-performance/manual`): new **admin-only** 📈 tab. **Ground** = one row per PM grouped by their dominant
    micro-market (per-MM subtotals + grand total); **KAM** = flat list + Overall. Backend columns computed client-side from the
    admin seed using **completed visits only** (Total Properties assigned, Visit/property, Visits/CP, T3&T4-CP visit-contribution
    count, Negotiation Aligned [future date] + Conducted, Visit→sale conversion %, Sale=Booking/ATS); Date + City filters apply.
    Manual columns (Engagement Meetings, Total Dialled, Connected %, Sales pending L1/L2/L3) are admin-editable, persisted to
    `team_perf_manual`; backend cells are read-only. CP Activation tab intentionally deferred. Additive only; `app.css`/`theme.css`
    byte-unchanged (scoped `tp-` styles). SSR-validated; backend gating + persistence smoke-tested live (admin 200 / non-admin 403).
- **2026-06-17 (Claude session — KH dates: matching fix + editable override, PR #9, migration 014):**
  Two Property-Status improvements. **(1) KH match fix** (`lib/propertyStatus.js`): the society-name join was exact-only,
  so units whose society carries a suffix/plural ("Godrej Aria, Sector 79" vs "Godrej Aria", "Gardens" vs "Garden",
  "Ph-1", appended cluster names) never matched an available KH date. `buildKhMap` now also indexes by unit, and a new
  `lookupKh()` does exact-first, else a **UNIQUE** society-PREFIX match (≥7 chars) for the same flat — recovers variants
  but never maps a *different* society's date. Validated vs live: **116→123** matches, 0 exact changed, every recovery
  verified correct (Godrej Aria, Sare Crescent Parc, Emaar Palm Garden(s), 16th Avenue, SVP Gulmohur, Skytech Merion).
  **(2) Editable KH date** (**migration 014** `kh_overrides` by `home_id` + `POST /api/kh-override` admin-gated):
  admins click the KH cell in the Property Status report → native date picker → persisted; the override **always wins**
  over the matched date and recomputes Days-Since-KH. `GET /api/key-handovers` now also returns `overrides` (loaded fresh,
  not cached; degrades gracefully if the table is absent). Non-admins are read-only. `buildPropertyStatusRows` gained a 4th
  `overrides` arg + `home_id`/`kh_overridden` on each row. CSS byte-unchanged (KH cell uses inline styles). Files: `main.py`,
  `propertyStatus.js`, `PropertyStatusTable.jsx`, `api.js`, `AnalyticsView.jsx` + migration 014.
- **2026-06-17 (Claude session — 3 fixes, frontend-only, PR #8):** (1) **Tazim → super-admin** — added `tazim` to
  `SUPER_ADMINS` in `App.jsx` (Book Visits access; he was already team=Admin). (2) **Mobile broker-modal "freeze" fixed** —
  on mobile the popup body was `height:auto`/`overflow:visible`, so a long visit list overflowed the clipped `100vh` modal
  with no scroll container (looked frozen). Made `#modal-broker .bp` a flex column with a bounded, momentum-scrolling body
  (`overflow-y:auto`, `100dvh` for the iOS toolbar) — scoped to ≤900px, desktop/other modals untouched (`theme.css`).
  ⚠ verify on a real iOS device. (3) **Analytics Property Status corrected** — was counting cancelled/upcoming visits by
  actual `visit_date`; now **completed visits only** (`isVisitCompleted`) bucketed by the **scheduled date** (`selected_date`,
  same convention as the raw visit table). Added trend columns **Last Week · 2/3/4 Weeks Ago · Last Month** (prev calendar
  month). Read-only; `weekWindows`/`buildPropertyStatusRows`/`PS_COLUMNS` are used solely by `PropertyStatusTable`. Validated
  vs live data (last-week 618→445, total 4254→3342). NOTE: "completed-only" now also applies to Hot/Warm/Cold and to Total.
- **2026-06-16 (Claude session — AI Suggestions tab, ALL roles · beta):** new per-user daily **morning brief**
  (`backend/api/ai_suggestions.py` + `views/AiSuggestionsView.jsx` + **migration 013** `ai_suggestions` + render.yaml
  09:30-IST cron). Reuses `scope_for_user` for who-sees-what, computes deterministic signals (near-closing / overdue /
  due-today / broker call-nudges / awaiting-update) from each user's scoped visits, and Claude Sonnet prioritises them into
  an **uncapped, priority-ordered, clickable** list (each point opens the CP modal or jumps to the buyer's visit). Validated
  live across KAM/PM/TL/Admin (scoping counts differ correctly: 448/80/322/881 active; refs valid). **Key fix:** the model
  initially returned empty priorities (`stop_reason=max_tokens` — it tried to emit a point per 40+40+40 signal item); fixed by
  passing Claude the TOP-15 of each list + max_tokens 3500, while the frontend renders the full clickable lists. App.jsx gained
  a `pendingSearch` ref for deep-link search (else byte-identical). Deploy: migration 013 applied; backend→Render, frontend→
  Vercel. `ANTHROPIC_API_KEY` already in Render (from Report Share) so the AI brief is live; the cron needs a Blueprint re-sync.
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
- **2026-06-13 (Claude session — property PM = visit RM instead of the property manager):** Report: "when a
  person creates a visit, they become the property's sales manager on the CRM rather than the property manager
  of the society." Root cause (confirmed): **no CRM code writes a visit onto a property** (`sync_visits` only
  touches `visits`/`buyers`; the only trigger is followup→visit). The leak is the **inventory sheet's
  `sales_manager` *name* column**, which upstream (oh-core) drifts to whoever last sold the unit (the visit
  RM). `sync_properties` stored that raw name verbatim in `properties.sales_manager`, which then surfaced as
  the "PM" in PropertyModal **and** leaked into name-based Ground scope (`_is_pm(p.sales_manager)` in
  `seed_snapshot`/`scopeVisits`/`properties.js`). The PHONE column (`sales_manager_contact`) is stable, so the
  phone-resolved `property_assignments` was already correct (e.g. Nirala Greenshire → Abhishek Dwivedi even
  while the name read "Abhash Kumar"/"Jatin Jain"). **Fix (`sheet_sync.sync_properties`, 1 function, +12/-3):**
  resolve the PM up front (phone-first) and store the **resolved PM's canonical name** in
  `properties.sales_manager`, falling back to the raw sheet name only when unresolved. Display + name-scope now
  follow the real PM, self-healing on each sync. **Deep validation (read-only sim over the live sheet + DB):**
  133/140 unchanged, 7 benign first→full normalizations ("Abhishek"→"Abhishek Dwivedi", same person, and that
  first name is unique to one user), **0 wrong-person changes**, **0 Ground users' scope changes** under
  current data, and no PM loses an assigned society; drift-robustness proven — feeding the earlier drifted
  names (Abhash/Jatin/Ajitesh/Udit) with each unit's current phone all resolve to the correct stable PM
  (Abhishek Dwivedi / Vinay Kumar). `py_compile` OK. **Caveat:** units where BOTH the name and the phone drift
  to the same RM can't be distinguished by phone — those need an authoritative society→PM roster / admin
  correction (not addressed here). **Deploy:** backend-only → `git push` → Render; applies on the next sheet
  sync.
- **2026-06-14 (Claude session — MOBILE REDESIGN, shipped in increments; all mobile-only & web-safe):**
  Goal: fix mobile freezes/glitches + move the phone UI toward best-in-class WITHOUT changing desktop/web.
  Every change is gated under `@media (max-width:900px)` or behind `useIsMobile()` (default bp **900**), so
  desktop (>900px) renders byte-identically and NO data/logic/scope is touched. Each increment shipped as its
  own validated, reversible Vercel deploy:
  - **Inc 1 — bottom tab bar + shell** (`19036e9`→merge `69a4568`): new `components/BottomTabBar.jsx` (Home /
    Visits / Partners / Property + a "More" bottom-sheet for Analytics / Inventory / My Day / Alerts) replaces
    the cramped top scroll-strip on phones. Aligned the CSS mobile shell to 900px — removes the old **761–900
    "dead zone"** (JS rendered mobile cards inside desktop chrome because `useIsMobile`=900 but the CSS shell
    was 760). 16px inputs on mobile (kills iOS focus-zoom); momentum scroll in `.modal-body`. New CSS block at
    the END of `app.css` (search "MOBILE REDESIGN") — base `.rx-tabbar{display:none}` + an `@media ≤900` block.
  - **Inc 2 — FiltersModal freeze fix + 44px tap targets** (`f14ab04`→merge `0f708f8`): the CP filter rendered
    up to **4,000 `<option>`s** in a `<datalist>`, freezing phones. WEB unchanged (still `brokers.slice(0,4000)`
    via the `!isMobile` branch); on MOBILE it renders a typed, capped (≤50) `cpOptions` list. + 44px min touch
    targets (`.x-btn`, `.rx-x`, `.m-card .mc-foot .qa`) under `@media ≤900`.
  - **Inc 3 — Inventory Snapshot mobile cards** (`849cd10`→merge `8f807f0`): `CityBlock` renders property CARDS
    on phones instead of the 7-col table (which overflowed); **desktop table byte-unchanged** (moved into the
    `else` branch). `.snap-mcard` CSS under `@media ≤900`.
  - **Inc 4 — Analytics compact raw table** (merge `5fb2c24`): the charts were ALREADY responsive (`.an-grid`→
    1 col at ≤900, line-chart SVG scales via `viewBox`, fluid CSS bars), so only the 11-col raw table needed
    work — on phones it shows 4 columns (Date/Apartment/Status/Buyer); CSV export still has all 11. Desktop
    table byte-unchanged.
  - **Reversibility:** a per-device `?classic` kill-switch was discussed but **NOT built** (kept deploys
    minimal). Reversibility = redeploy the prior Vercel bundle (Vercel "Instant Rollback") or `git revert` the
    merge. Desktop is untouched by construction.
  - **STILL PENDING (mobile polish):** modal sticky-close + sized scroll regions; a density pass. Nav, charts,
    snapshot, filter-freeze, tap-targets, iOS-zoom are done.
  - **Tooling caveat:** pixel-precise on-device mobile testing was blocked (Preview viewport not controllable;
    connected Chrome couldn't open an MCP tab group). Mobile validation was code/CSS review + clean build +
    desktop render-smoke + offline timing — NOT a live phone render. **Test on a real phone** after mobile work.
- **2026-06-14 (Claude session — KAM extra-city visit access; admin toggle; migration 010 APPLIED to prod):**
  Lets an admin grant a specific KAM visibility **and edit** of *all visits in chosen cities*, on top of their
  own CPs. Applied per request: **Saket → Noida + Ghaziabad, Mukul → Gurgaon** (both ON); every other KAM OFF.
  - **Data model (`010_user_extra_cities.sql`):** `users.extra_cities text[] DEFAULT '{}'` +
    `extra_cities_enabled boolean DEFAULT false`. Both default OFF → zero scope change for anyone until set.
    Mirrors the `micro_markets` column pattern. Idempotent (`ADD COLUMN IF NOT EXISTS`).
  - **Scope (`seed_snapshot.scope_for_user`, KAM branch ONLY):** if enabled + cities set, the KAM also gets
    every visit whose `city ∈ extra_cities`, PLUS those visits' CPs added to their broker set so cards/pop-ups
    resolve. CpView still filters its CP *list* to own+T3/T4, so the book isn't flooded — the extra CPs live in
    `seed.brokers` only for pop-ups. Mirrored in frontend `lib/visits.js scopeVisits`.
  - **Edit permission (`_can_edit_visit` in `main.py` + `PropertyModal` canEdit — merge `bf00b51`):** follow-up
    fix. The grant first added visibility only, so targets could SEE the extra cards but saves 403'd. Now a KAM
    can EDIT visits whose `city ∈ extra_cities` (added `v.city` to the query). Gated on team==KAM + the toggle.
  - **Plumbing:** `auth.py` (both user SELECTs now include the 2 columns — REQUIRED, scope reads the auth dict);
    `seed_snapshot` (roster query + projection); `main.py` (`/api/me` + `/api/seed` current_user, create/update
    models, POST, PATCH); `UserModal.jsx` (toggle + cities chip-input, shown only for KAM users). Commits
    `27563df`→merge `b98f7a3`, then `bf00b51`.
  - **DEPLOY ORDER MATTERS:** migration FIRST (old code ignores the new columns), THEN push backend (new code
    SELECTs them), THEN frontend, THEN set the grants. Migration 010 + the Saket/Mukul grants are already
    applied to prod.
  - **Validation (offline + live):** toggle OFF → every KAM byte-identical to before; Saket 362→**3,411**
    visits live, Mukul 444→**6,139**, control KAM Mayank unchanged (641); only Saket+Mukul have any grant in
    the DB; targets can edit 100% of what they see.
  - **Admin usage:** User modal → open a KAM → "Extra-city visit access" toggle + cities (Gurgaon/Noida/
    Ghaziabad). **Reversibility:** flip the toggle off (instant, per-user, no deploy) or `git revert`.
  - **Consequence — bigger seed:** granted KAMs load far more (Mukul 4.4MB→**11.7MB**), so their app LOAD is
    slower on mobile data (download-bound, skeleton shown) — NOT a per-screen freeze (next entry). To shrink:
    drop the extra-city CPs (added only for pop-ups) from the payload.
- **2026-06-15 (Claude session — "freeze opening visit/cp screen" — diagnosed, NO code change):** Measured the
  real paths over the live large seeds: opening Visits computes ~17 ms, CP ~20 ms, `JSON.parse` of the whole
  seed ~35 ms — all <~250 ms even on a slow phone, masked by a loading skeleton. `ownedCpCodes`/`buildCpIndex`
  are clean single passes (no O(n²)). **So per-screen navigation is NOT a compute freeze.** The one heavy
  factor is SEED SIZE (11.7MB Mukul / 15.9MB admin), worsened for the extra-city KAMs. The earlier concrete
  freeze (4,000-option filter list) is fixed. Real fix for the size = server-side visit pagination (TODO).
- **2026-06-15 (Claude session — two prod fixes shipped + a super-admin booking tab):**
  - **(A) Old-Leads recency/activity guard — DEPLOYED + migration 011 applied (PR #3 → `main`).** Root cause:
    `sheet_sync.sync_inactive_leads()` (the migration-005 rule) flagged a visit **Old + dead** the instant its
    unit left live inventory, with **no recency check** — so a *yesterday* visit on a just-`Booked`/`Sold` unit
    was swept into Old Leads and its `lead_status`/`next_followup_date`/`revisit_date` wiped every 15 min (~240
    visits dated ≤30d mis-filed; e.g. VST9335 Panchsheel Greens 2, unit `Booked`). New rule (`sync_inactive_leads`
    + **migration 011**): a visit is Old only if its unit is dead-inventory **AND** >60d old **AND** never actioned
    (`latest_followup_at IS NULL`) **AND** not in an active stage (negotiation/booking/ATS/revisit/need-more).
    Migration 011 also **repaired** the damage — re-projected each actioned lead's latest follow-up from the
    intact `followups` table (940 rows) and reset never-actioned residue to "Not Updated" for the sheet to refill.
    Prod effect: Old Leads **5,602 → 4,679** (923 returned to Active), recent-but-old **240 → 0**. Verified stable
    across 2 full sync cycles. Files: `backend/api/sheet_sync.py`, `backend/migrations/011_old_lead_recency_guard.sql`.
  - **(B) Visit RM follows the current PM assignment — DEPLOYED (PR #3).** After a society handover (Godrej Oasis
    → Puran, 2 Jun) the Visits **RM column** still showed the old PM (Shubham, 207/341 rows) because
    `sales_manager` is sheet-sourced and lags. `seed_snapshot.build()` now sets the **displayed** `sales_manager`
    from the unit's current PM assignment (`rm_override` > current PM by `home_id` / single-PM society > sheet RM)
    and adds **`sales_manager_raw`** which ALL scoping reads (`scope_for_user` lines 83/141/149 + frontend
    `scopeVisits`) — so visibility is **byte-identical**, only the displayed RM changed. Effect: Godrej Oasis
    201/304/704 → Puran; 204-E correctly stays Shubham (genuinely his unit). Files: `backend/api/seed_snapshot.py`,
    `frontend/src/lib/visits.js`.
  - **(C) Book Visits tab (BETA · super-admins only) — frontend-only, PREVIEW (writes nothing), deployed.** New
    `views/BookVisitsView.jsx` (self-contained; styles scoped under a `bv-` prefix in a `<style>` block, so **no
    `app.css` change**) + a gated NAV entry in `App.jsx`. Mirrors the Snapshot tab's filters; select **up to 10**
    live units (Ready/Coming Soon with a `home_id`); single or bulk; collects CP (searchable, from `seed.brokers`,
    `broker_id` = `broker.id` = core `external_id`), date, time slot, buyer name + **last 5–10 mobile digits**
    (partial by design). A **detailed confirmation** step shows every field (unit, home_id, CP name/code/tier,
    buyer, date, time) with a bold **"cannot be edited or undone"** warning. **Gated by EXACT slug**
    (`SUPER_ADMINS = {akshit, saransh}` in `App.jsx`) on the **real** signed-in user (never the impersonated `me`)
    — `team`/`role` are NOT used (ashish/ankit/sahaj are also Admin/admin). Proven across 9 user types; every other
    admin/Ground/KAM nav is **byte-identical** to before. **`BOOKING_LIVE=false`** → Confirm is a labelled preview
    that writes nothing and calls nothing; to go live, flip that one flag + add the server-side call. The app-backend
    contract is **`docs/APP_BACKEND_BOOKING_API_SPEC.md`** — ONE endpoint that takes ≤10 visits at once but creates
    them **sequentially**, reusing the existing single-create logic (check → buyer → schedule-visit), auth =
    `X-CRM-Key` + `created_by` phone/email → SalesManager (⚠ akshit & saransh have no phone in the CRM → email
    fallback). **Validation:** frontend build (0 errors, `app.css` byte-unchanged), gating unit test (9 user types
    + non-super-admin nav identical), SSR smoke render (no crash; filters to bookable units only), real-component
    visual of the confirm screen. **Change set: 2 code files** (`App.jsx` +5 additive lines, `BookVisitsView.jsx`
    new) — no backend, no data writes, no other user affected.
  - **(D) Hiring tab (BETA · admins only) — DEPLOYED + migration 012 applied.** A city × micro-market planning
    table: property bifurcation (Ready/Coming-Soon/Archived) → Total + **currently-assigned PM count**, off
    `all_properties` (incl. Archived, which the seed lacks). New **read-only** `GET /api/hiring` (admin-gated
    aggregation: counts from all_properties + distinct current PM per MM from `property_assignments`). Admins can
    **fill blank micro-markets** — ~21 (mostly Archived) societies have no MM; an admin assigns one via `POST
    /api/hiring/mm-override`, stored in the new isolated **`hiring_mm_overrides`** table (**migration 012**) and
    applied ONLY as a COALESCE fallback (a unit's real MM always wins; never mutates `all_properties`). New
    `views/HiringView.jsx` (self-contained, styles scoped under `hr-`, no `app.css` change). Gated in `App.jsx` by
    `adminOnly` → `me.team === 'Admin'` (8 Admin-team users incl. super-admins). **Validation (zero prod writes):**
    aggregation validated read-only against prod (9 MM rows / 188 props / 21 blanks; PM counts match); full GET+POST
    round-trip proven in a ROLLED-BACK txn (override rolls Amrapali Zodiac's 3 archived units into Noida Extension,
    blanks 21→20, then clears back); gating unit test across 8 user types (Hiring=team Admin, hidden from TL/KAM/
    Ground; non-admin nav byte-identical); SSR smoke render; frontend build 0 errors. Migration 012 is additive +
    isolated (CREATE TABLE IF NOT EXISTS, touches no existing table/data). **Change set:** `main.py` (2 new admin
    endpoints), `api.js` (2 fns), `App.jsx` (+4 additive lines), new `HiringView.jsx` + migration 012.
  - **(E) Report Share tab (BETA · admins only) — DEPLOYED & FULLY LIVE 2026-06-15 (PR #6, commit d76ab97).** Live-verified
    end to end on prod: deployed backend admin 200 / Ground 403; a real Gmail draft created via the prod backend (SA +
    domain-wide delegation + Gmail API all confirmed working in prod); and **`ANTHROPIC_API_KEY` now set in Render** →
    the **AI summary is live in prod** (validated: structured summary returned, generic pricing / no figures, effort-forward
    tone). Backend → Render (auto on merge); frontend → `vercel deploy --prod` (authenticated CLI). The summary prompt was
    tuned (2026-06-15) to keep pricing generic (no figures), keep tone effort-forward, and never surface property-upkeep or
    internal-process issues. A seller
    **property performance report**, generated from live visit data and saved as a **draft in the triggering admin's own
    Gmail** (recipient left blank; nothing is sent). New `backend/api/reports.py`: `build_report_data(conn, home_id)`
    (metrics keyed on `home_id` so they reconcile EXACTLY with the Analytics Property-Status tab — Godrej Oasis A-704:
    55 to-date / 4 last-7d / 6 Hot+Warm, all verified equal to the app), `summarize_feedback()` (**Claude Sonnet**
    `claude-sonnet-4-6`, forced tool-use → structured {headline, positives, objections, notable_leads, assessment,
    recommendations}; **graceful** — returns `None` with no key/feedback so the report still renders), `render_report_html()`
    (branded, inline-styled email — OpenHouse orange/slate, table-based for email clients), `create_gmail_draft()`
    (**service-account domain-wide delegation**, `subject=<caller>`, `gmail.compose`, **draft only**). Two admin endpoints
    `POST /api/reports/property` (preview, read-only) + `/draft` (`asyncio.to_thread` for the blocking SDK/Gmail calls).
    New `views/ReportShareView.jsx` (self-contained, styles scoped under `rp-`, no `app.css` change): property picker →
    sandboxed-iframe email preview → editable subject → "Create Gmail draft" with a friendly `503` if delegation isn't
    enabled. `anthropic==0.102.0` added to `requirements.txt` (**lazily imported** — app boots without it); `config.py`
    gains `ANTHROPIC_API_KEY`. **Validation (zero prod writes, no draft created):** metrics reconciled against the live DB;
    backend imports clean + routes registered; direct-handler gating test (admin preview 200 with correct metrics / Ground
    + KAM 403 on both endpoints / unknown home_id 404); Claude path degrades to `None` without a key; HTML render
    screenshotted (no template leaks, no scripts); frontend build 0 errors with **`app.css`/`theme.css` byte-unchanged**
    (`rp-` styles 0× in CSS bundle, 19× in JS — proven inline); SSR smoke render (picker, rows, no-`home_id` excluded).
    **Blocked on (deploy prerequisites, see §10):** (1) `ANTHROPIC_API_KEY` → Render `oh-crm-secrets`; (2) Workspace admin
    authorises SA client_id `103924240682962245131` for `gmail.compose`. **Change set:** new `reports.py` +
    `ReportShareView.jsx`; `main.py` (+2 endpoints, `import asyncio, reports`), `api.js` (+2 fns), `App.jsx` (+3 additive
    lines), `config.py` (+1), `requirements.txt` (+1). No DB migration. No data writes; no other user/view affected.
- **2026-06-09 (Claude session — Home Gold+Silver counter → completed-only):** The "live" monthly Gold+Silver
  counter counted ALL June T1/T2 visits (413 = 306 completed + 60 upcoming + 47 cancelled). Verified straight
  from the raw sheets (visits sheet + "18 Broker Tiers" sheet): **306**, matching the *completed* count to the
  number. The 107 extra were upcoming/cancelled rows that are dateless in the sheet (`"None"` in both date
  cols) and got stamped with the sync date (June 15). Per owner: changed `HomeView` `gs` to count
  `isVisitCompleted(v)` only (excludes upcoming/cancelled); label now "completed visits from Gold + Silver
  CPs". `HomeView.jsx` only; **frontend deploy**.
- **2026-06-09 (Claude session — "After Negotiation FU" missing from the follow-up form):** The stage existed
  in the master `STAGES` (so it showed in the Visit-stage chip-bar + auto-applied when the negotiation date
  passed), but the original negotiation work never added it to the form's selectable **Next-Stage pills** —
  `FU_STAGES` (PropertyModal) + `STAGE_PILLS` (BrokerModal) — nor to PropertyModal's `STAGE_ORDER` tab
  grouping. So you couldn't pick "After Negotiation FU" when logging a follow-up. Added it after `negotiation`
  in all three lists (mirrors how After-Revisit-FU follows Revisit-Scheduled). Frontend only; **vercel deploy**.

---

- **2026-06-18 (Claude session — CRM→Core visit booking WIRED):** Built the live booking path per
  `docs/CRM_VISIT_BOOKING_GUIDE.md`. **Migration 008** + `sheet_sync.sync_sales_manager_ids()` map CRM users
  → Core `SalesManager.id` (`users.core_sales_manager_id`) from the inventory "Sales managers" tab (phone,
  name fallback). New **`POST /api/visits/book`** (`main.py`, admin-only) orchestrates Core's 3 server-to-server
  APIs with `X-CRM-Key`: per unit `check-existing-buyer-for-home` (45-day lock + buyer reuse) → `buyer/`
  (create if needed) → batched `crm/schedule-visits/`; resolves `sales_manager_id` from the logged-in RM;
  merges locked/error rows with schedule results into ordered per-row output; verbose `[book]` logs (mobiles
  masked, key never logged). Config: `CRM_BOOKING_API_BASE_URL`, `CRM_API_KEY` (`config.py`). Seed
  `current_user` gains `can_book_visits` + `phone`. Frontend `BookVisitsView` flipped live (`BOOKING_LIVE=true`),
  `confirm()` calls `bookVisits()` and renders real ✓booked / ✗locked-or-error rows; "not set up" guard when
  unmapped. **Deploy: backend (Render env: base URL + `CRM_API_KEY`) + frontend (`vercel deploy`).**
  **✅ TESTED end-to-end on staging** (env on Render + local): as Saransh (`sm_id 82`, the STAGING test SM) +
  CP00670 (`broker_id 765`) → created staging visits **7451/7452/7453**; single, 2-visit batch, buyer
  create + reuse, and per-row results all verified; the `[book]` trace is clean (mobile masked). The 45-day
  `locked` branch couldn't be reproduced on staging (lock needs a *completed* visit; ours are `upcoming`).
  **Note:** sheet `sales_manager_id`s are PROD ids (real for everyone except Saransh, whose **82 is a STAGING
  placeholder**). Current Render env points at **staging Core**, so test with **Saransh** there. For PROD
  go-live: swap Render env to the prod Core URL + key, and set Saransh's REAL prod SalesManager id.
  **Deploy backend (Render) + frontend (`vercel deploy`) to expose it in the CRM UI.**

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
10. **Mobile polish (remaining)** — modal sticky-close on a long scroll + sized scroll regions, and a density
    pass. The bottom tab bar, card layouts, filter-freeze fix, tap targets and iOS-zoom are done (§9 06-14).
11. **Seed size / server-side visit pagination** — `/api/seed` is large for big-scope users (admin ~15.9MB;
    extra-city KAM Mukul ~11.7MB) → slow load on mobile data. Real fix = paginate visits server-side (also
    closes the long-standing "/api/seed is large" gotcha in §8). Quick partial: drop the pop-up-only extra-city
    CPs from granted-KAM payloads to shrink them.
12. (Optional) **Per-device mobile `?classic` kill-switch** — discussed during the redesign, NOT built;
    current mobile reversibility is Vercel Instant Rollback / `git revert`.
13. **Test the mobile UI on a real phone** — on-device testing was tooling-blocked in the build sessions
    (Preview viewport / Chrome MCP tab group); confirm tab bar / cards / Snapshot / Analytics on an actual device.
14. **Take "Book Visits" live** — blocked on the app backend building the endpoint in
    `docs/APP_BACKEND_BOOKING_API_SPEC.md`. Then: (a) the app team returns the URL + `X-CRM-Key` + confirms the
    `created_by` phone/email→SalesManager mapping (⚠ akshit & saransh have **no phone** in the CRM — add one or use
    email fallback); (b) add a CRM backend proxy endpoint (holds `X-CRM-Key`, forwards the super-admin's identity);
    (c) wire `BookVisitsView` Confirm to it and set **`BOOKING_LIVE = true`**; (d) validate one real booking end-to-end,
    then widen `SUPER_ADMINS`. Until then the tab is preview-only and writes nothing.
15. ~~**Take Report Share live**~~ **✅ DONE 2026-06-15 (PR #6).** Fully live & prod-verified: admin 200 / Ground 403; real
    Gmail draft via prod backend; AI summary live (`ANTHROPIC_API_KEY` set in Render). Gmail API enabled (project
    `polished-logic-434606-g3`), domain-wide delegation set (client `103924240682962245131`, scope `gmail.compose`). Operational
    notes for the future: the `/draft` `503` message distinguishes "Gmail API not enabled" vs "delegation not authorised"
    (`reports._gmail_setup_error`); if the AI summary ever goes blank, check the Anthropic Console spend/usage limit (akshit's
    account hit a monthly cap once — "regain access 2026-07-01"). There is **no Render CLI/API key on disk** — Render env vars
    must be changed via the dashboard. Housekeeping: the `[CRM TEST]` / `[PROD TEST]` drafts in akshit's Gmail can be deleted.
16. ~~**Report-only access tier (supply team)**~~ **✅ DONE 2026-06-22 (PR #32).** New `team='Report'` grants the Report
    Share feature + the live-property picker ONLY — least-privilege by construction: `Report` != `Admin`, so every
    `_require_admin` / `_require_admin_or_tl` route still 403s, and `seed_snapshot.scope_for_user` returns a
    **properties-only** snapshot (no leads/brokers/visits/queues/notifications; the report is built server-side per
    `home_id`, so the empty visits list doesn't limit it). Report endpoints gated by `_require_report_access` (Admin OR
    Report); `Report` added to `VALID_TEAMS`. **Migration 017** widened the `users.team` CHECK (verified constraint name
    `users_team_check`). Frontend: Report users get exactly one tab (Report Share), body pinned so nothing else is
    reachable; team pill/label added. **4 supply users provisioned** (all `role=report_viewer`, active): `shashank`,
    `rupali`, `abhishekr` (the obvious `abhishek` slug was already taken by Abhishek Dwivedi/Ground — caught during a
    live-DB pre-flight check), `animesh`. Gmail draft works for them (domain-wide delegation, not per-user). Verified
    post-change roster: Admin 9 / Ground 30 / KAM 4 / TL 3 / **Report 4** (total 50); all existing rows untouched.
    Open boundary: like any non-admin, a Report user could still call secondary read endpoints (`/api/cps`,
    `/api/inventory`) directly — the UI exposes only Report Share; hard server-side denial on those is a future option.
    **UPDATE 2026-06-25 (PR #39):** `khushi.sharma` added as a 5th Report user (Report 4→5; non-Report 48 unchanged).
    Report users can now be added from the **Team & Assignments → Add member** form: `UserModal` `TEAMS` + `TeamView`
    `TEAM_ORDER` gained `'Report'` (the latter also un-hid the existing Report users, who weren't being grouped before).
    Backend `/api/users` already accepted `Report`. So future Report (or any) members can be self-served from the UI —
    no SQL needed.
17. ~~**Negotiations tab + removed the negotiation auto-advance**~~ **✅ DONE 2026-06-22 (PR #33).** New **Negotiations**
    tab (`frontend/src/views/NegotiationsView.jsx`, NAV key `negotiations`) for the funnel negotiation / after_negotiation_fu /
    booking: per-lead **"Did the meeting happen?"** Yes/No → next step or reschedule; for after-neg / booking leads a forward
    next-step editor; captures **booking-received date** (required when the resulting stage is `booking` — enforced in the
    tab UI only) and surfaces derived **scheduled-on** / **moved-to-booking** timestamps (from `seed.followups`, no new
    storage). Reuses the shared Visits `filters` + search, adds a **negotiation-meeting-date range**. Scoped per user like
    Visits; auto-hidden for the `Report` team. **Removed the display-time auto-advance** `negotiation → after_negotiation_fu`
    in BOTH `lib/visits.js` (`visitStage`) and the Python AI-brief port `ai_suggestions.py` (`visit_stage`) — the lead stays
    `negotiation` until the team acts; the parallel **revisit** auto-advance is intentionally kept. **Migration 018** added
    nullable `negotiation_happened` + `booking_received_date` to `followups` + `visits` and extended
    `project_followup_onto_visit()` (full body reproduced verbatim; applied to prod BEFORE the new backend went live so
    `save_followup` never 500'd). `save_followup` persists both with **no new hard validation** → existing
    BrokerModal/PropertyModal booking saves are unchanged. Follow-ons: `teamPerf.js` keeps "Negotiation conducted" counting
    past-dated negotiations (admin metric numerically unchanged); stale "auto-moves" hints fixed in BrokerModal/PropertyModal.
    **Impact (verified):** 9 past-dated negotiation leads now display as *Negotiation* (was *After Negotiation FU*) in Visits
    + the new tab — display only, no data change; Property Performance "Negotiation" column rises by ≤9 (accepted). Funnel
    counts unchanged (neg 30 / after-neg 6 / booking 21); 0 rows written to the new columns at deploy.
18. ~~**Admin "Add CP" — register a channel partner in Core**~~ **✅ DONE 2026-06-25 (PR #36).** New admin-only **Add CP**
    tab (`frontend/src/views/RegisterCpView.jsx`, NAV key `register-cp`, `adminOnly`) replicating the Meetings app's
    Supply→"Register a partner". Collects name / 10-digit phone / email / company / city / micro-markets; the FastAPI backend
    proxies Core's CP-Meetings broker API server-side (`backend/api/cp_meetings.py`, ported 1:1 from the app's
    `lib/cpMeetingsApi.js`): `GET /api/cp-register/cities` + `/micro-markets`, `POST /api/cp-register` — **all `_require_admin`**.
    The CP is attributed to the admin's own `core_sales_manager_id` (same gate as Book Visits → 422 if unmapped); Core
    allocates the cp_code and dedupes (duplicate phone → 400). The new CP flows into the CRM at the next sheet sync —
    **nothing is written to the CRM DB**. Server-side key `CP_MEETINGS_API_KEY` (+ `CP_MEETINGS_API_BASE`, defaulted to the
    Core run.app URL) in `config.py`; **set the key in the Render dashboard** to activate. Until then `is_configured()` is
    false → endpoints return `{configured:false}` / 503 and the tab shows "not set up yet" (safe to ship un-keyed). Fully
    additive: no migration, no change to existing endpoints/views/data; hidden from non-admins + the `Report` team.
    **UPDATE 2026-06-25 (PR #37):** Add CP opened to **everyone** incl. the `Report` team — `register-cp` nav un-gated +
    added to the `isReportViewer` nav list; body ternary restructured (`isReportViewer && view==='register-cp' → RegisterCpView`);
    backend `_require_admin` dropped from the 3 `/api/cp-register*` routes (auth + `core_sales_manager_id`→422 gate kept).
    `CP_MEETINGS_API_KEY` set in Render — feature is **live & prod-verified** (cities Gurgaon/Noida/Ghaziabad load).
19. ~~**Tabular Negotiations + Revisits tab, Snapshot PM, Properties KH**~~ **✅ DONE 2026-06-25 (PR #37).** New shared
    `frontend/src/components/PipelineQueue.jsx` (Visits-style table + mobile cards + inline editor, parameterized per-mode via
    `CFG.negotiation`/`CFG.revisit`). **Negotiations** is now tabular (meeting date column prominent + sortable) with a day-of
    **✅/❌ "did the meeting happen?"** on the scheduled row (reuses `negotiation_happened`); `NegotiationsView` slimmed to a thin
    wrapper (same scope/filters/chip-bar/neg-date-range). New **Revisits** tab (NAV `revisits`, after Negotiations) = same
    component for `revisit_scheduled`/`after_revisit_fu`; its Yes/No is **migration-free** (routes the next step) — reschedule
    writes `revisit_date`, NEVER targets `after_revisit_fu`, NEVER sends `negotiation_happened` (`CFG.revisit.sendsHappened=false`).
    Target-stage date rules generalized (negotiation→neg date, revisit_scheduled→revisit date, booking→booking-received date).
    **Inventory Snapshot:** PM (`sales_manager`) shown under the society (desktop + mobile card); **poster export untouched**.
    **Properties:** new **KH Date** column via `loadKeyHandovers` + `buildKhMap`/`lookupKh` (home_id override wins), sort branch +
    empty `colSpan` 14→15; loads async like Property Performance (158/173 units populated). Prod-verified live (neg 56 / rev 94
    rows, 0 console errors, Report-user Add CP renders). **No migration, no DB writes; VisitsView + save_followup untouched.**
    Not live-tested: an actual negotiation/revisit SAVE (avoided writing to a real lead) — editor + ported logic verified by review.
    **CORRECTION 2026-06-25 (PR #38):** the Negotiations Yes/No is a **PRE-meeting** confirm, not post. Now asks "Will this
    meeting happen today (is it confirmed)?" — **Yes** → confirmed, lead STAYS in negotiation (keeps its date, note optional,
    `negotiation_happened=true` reused as "confirmed", a ✓ marks confirmed rows); **No** → reschedule new date or change stage
    (note required). Outcome (Booking/After-Neg) is recorded later via the normal follow-up. Driven by per-mode
    `CFG.preMeeting` in `PipelineQueue.jsx` — **Revisits intentionally left as post-meeting** ("did the revisit happen?").
    Frontend-only, no migration (only 1 prior `negotiation_happened` row). Prod-verified: neg question/Yes-confirm/No-reschedule
    correct, revisit unchanged, 0 console errors.
20. ~~**Property Status: dedup duplicate units + Ongoing-offer / Demand-remark columns**~~ **✅ DONE 2026-06-25 (PR #40).**
    **Dedup:** the inventory sheet listed 2 units twice (same Core `home_id`, different `property_name` — `AJ - 2002` +
    `AJ - 2002 (Top Floor)` / `home_id 127`; `N - 40D` + `Block N - 40D` / `home_id 241`). `property_name` is the unique sync
    key so both survived; visit-matching joins on `home_id` so both matched the SAME visits → double count. `buildPropertyStatusRows`
    (`lib/propertyStatus.js`) now **collapses same-`home_id` rows to one** (keeps the shorter property_name) — display-only,
    **self-healing** for future dups. Prod-verified: count 175→**173**, Antriksh AJ-2002 & Smart World N-40D each show once.
    (Scope = Property Status report only; the raw Properties/Snapshot lists still show both rows but don't aggregate.)
    **2 manual columns** (Ongoing Offer, Demand Remark) — inline click-to-edit, **Admin + TL** (`_require_admin_or_tl`),
    persisted per `home_id`, mirroring the KH-override exactly: **migration 019** `property_review_fields` (isolated table; GET
    degrades gracefully if absent, applied to prod BEFORE the POST went live), `GET /api/key-handovers` also returns `review`,
    new `POST /api/property-review`, `EditTextCell` in `PropertyStatusTable` + `PS_COLUMNS` + row-attach + `setPropertyReview`.
    The 5 no-`home_id` units show the columns read-only (same limitation as KH). Prod-verified: columns render, save round-trips
    (set→persist→clear, throwaway key, zero residue), edit affordance opens, 0 console errors. Additive — KH logic /
    visit-matching / Properties+Snapshot / existing data untouched.
21. ~~**Default leads source filter = via CP**~~ **✅ DONE 2026-06-25 (PR #41).** The shared leads `filters` (Visits /
    Negotiations / Revisits) now initialises to `{ source: ['channel_partner'] }` (`App.jsx`) so **Direct leads are hidden by
    default** — a user must add "Direct" in the Filters modal to see them. The modal **Reset** also returns to the via-CP
    default (`FiltersModal.jsx`), so Direct always needs an explicit mark. Frontend-only, no data touched. Source values in the
    data: `channel_partner` 9110 / `direct` 988 / `lsq_migration` 4 (last two hidden by default; only Direct is a filter
    option). Filters badge shows "1" by default; prod-verified (Visits shows CP-only "1–60 of 4868", Source modal = via CP ON).

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
