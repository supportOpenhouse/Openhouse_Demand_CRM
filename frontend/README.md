# OpenHouse Demand CRM — frontend (React + Vite)

This is the CRM frontend: a React + Vite app. It replaced the old single-file
`crm.html` (~5,700 lines), which has been retired. Vercel builds this directory
(`npm run build` → `dist`) and rewrites `/api`,`/auth`,`/health` to the Render
backend (see `vercel.json`).

## Run locally
```bash
cd frontend
npm install
npm run dev          # http://localhost:5173  (proxies /api,/auth,/health → 127.0.0.1:8011)
```
Start the backend first (DEV_MODE on :8011), then sign in via
`http://localhost:5173/auth/dev_login?slug=saransh` (the dev proxy forwards it).

## Architecture
- `src/api.js` — `apiFetch` + `loadSeed` (same-origin; cookies; 401 → Google login)
- `src/theme.css` — legacy theme copied verbatim (pixel-identical look)
- `src/app.css` — `rx-*` shell layout + motion (loader, view transitions, skeletons)
- `src/components/` — shared UI (Loader, …)
- `src/App.jsx` — shell: topbar + sidebar nav + global loader + animated views
- `src/views/` — one file per view (added as each is ported)

## Done so far
- ✅ Scaffold, build pipeline, dev proxy to the live backend; theme ported verbatim;
  branded loader; animated view transitions; nav shell.
- ✅ **#2** — real signed-in user from `/api/seed`; loader covers the fetch (no "Akshit" default).
- ✅ **Visits view** — `#4` unit-number filter · `#6` "Old Leads" (Active/Old/All) · `#8`
  clickable Hot/Warm/etc. stat boxes · city/stage filters · search.
- ✅ **Channel Partners view** — `#1` one-pass per-CP index + pagination (instant even for
  the ~2,400-row T4) · `#4` unit filter · `#5` CP-owner column hidden for T3/T4 (DB cleared).
- ✅ **Properties list + Property modal** — `#7` "All" stage tab · `#8` clickable Hot/Warm ·
  `#9` Last FU taken + by in Top Brokers · OpenHouse · Top Brokers · 99acres tab with inline
  10-digit phone editor.
- ✅ **Broker popup** (click a CP row) — visit history, **follow-up logging** (buyer status /
  stage / next-FU / revisit / note → `POST /api/followups`), and tier / CP-owner edits (admin).
  After any write the seed re-fetches so all views stay consistent. Global toasts.
- ✅ **Notifications** — list + unread nav badge + mark-one / mark-all read.
- ✅ **To Be Assigned** (admin/TL) — queue of unassigned CPs with per-row owner+tier assign
  (`POST /api/brokers/bulk_assign`); assigned CPs drop out after re-fetch.
- ✅ **Broker popup → Engagement tab** — `POST /api/engagements` (notes + inventory/recording/
  listing/support flags + listing link/date + remarks).
- ✅ **Broker popup → per-visit Nudge** — shows existing nudges (`nudges_by_visit`) and sends new
  ones to the CP owner (`POST /api/nudges`).
- ✅ **Inventory Snapshot** — grouped by city → micro-market, share-ready, with **Copy text** per
  city (WhatsApp-ready).
- ✅ **Team & Assignments / My Day** — admin/TL roster grouped by team with per-member CP counts;
  non-admins see "My Day" (their CPs). CP rows open the broker popup.
- ✅ **Broker popup hoisted to App** — opens from Channel Partners, **Visits** (click a CP name),
  **Property modal** (Top Brokers · OpenHouse rows), and **My Day**. Stacks above the property modal.
- ✅ **Mobile baseline** — shell stacks, sidebar becomes a scroll strip, modals go full-screen, forms
  single-column, tables scroll.

- ✅ **Notification deep-links** — clicking a notification opens the related CP's popup.
- ✅ **Multi-select bulk assign** — checkboxes + bulk owner/tier bar in the queue.
- ✅ **WhatsApp** quick-action — opens `wa.me` with the broker's number from the popup.
- ✅ **Snapshot image export** — per-city PNG via html2canvas (code-split), plus text copy.
- ✅ **Error boundary** — a view crash shows a retry card instead of white-screening the app.

## Functional parity reached
React now does everything `crm.html` does **that actually works against the backend**, and then some:
- ✅ **Member add/edit** — real now (legacy only mutated an in-memory array and never persisted).
  Admins get **＋ Add member** and a hover **Edit** on each roster card → `UserModal` →
  `POST /api/users` / `PATCH /api/users/{slug}`. Validates email domain, 10-digit phone, unique
  slug/email; deactivate (active=false) removes someone from the roster while keeping their history.
  Backend gate is **Admin only** (KAM/Ground → 403).
- ✅ **Motion** — uniform view-enter transitions, press feedback on every button/tab/segment, a
  top progress bar during post-write seed re-fetches, staggered roster-card entrance. All
  product-register timing (≤260ms, ease-out curves) and fully disabled under `prefers-reduced-motion`.
- ✅ **Skeletons** — full-shell skeleton on initial load (topbar + sidebar + stat row + table) instead
  of a bare spinner; skeleton table while the 99acres tab fetches.
- Mobile is a **responsive baseline** (stacks, scrolls); full bespoke card layouts are cosmetic.

> Design motion follows the `impeccable` skill's product-register guidance (installed under
> `.claude/skills/impeccable`): `/animate` for the motion layer, `/optimize` for the loading states.

## Verification (automated checks that passed)
- **All 12 API endpoints** the app calls exist in the backend and are reachable with auth:
  `/api/seed` 200 · `/api/top-brokers` 200 · `…/phone` set+clear 200 · `/api/followups` (422/404 on
  bad input) · `/api/engagements` 422 · `/api/nudges` 404 · `/api/brokers/{cp}/tier` 404 · `…/owner`
  404 · `/api/brokers/bulk_assign` 400 · `/api/notifications/*` · `/auth/google/start`.
- **Production build** (`npm run build`) → `dist` serves cleanly via `vite preview`: html, JS, CSS,
  `/openhouse_logo.png`, `/brand/logo-icon.svg` all 200; favicon + theme-color set.
- No `console.log` debug; `<ErrorBoundary>` guards every view; html2canvas is code-split.

### Parity matrix (legacy → React)
| Legacy | React | Status |
| --- | --- | --- |
| Visits | `views/VisitsView.jsx` | ✓ + unit filter, Old Leads, clickable Hot/Warm |
| Channel Partners | `views/CpView.jsx` | ✓ + per-CP index (fast), unit filter, T3/T4 owner hidden |
| Properties + modal | `views/PropertiesView.jsx`, `components/PropertyModal.jsx` | ✓ + All-stage, Hot/Warm, Top-Brokers FU, 99acres + phone |
| To Be Assigned | `views/QueueView.jsx` | ✓ single + multi-select bulk assign |
| Inventory Snapshot | `views/SnapshotView.jsx` | ✓ text + PNG export |
| Notifications | `views/NotificationsView.jsx` | ✓ read / read-all / deep-link |
| Team / My Day | `views/TeamView.jsx` | ✓ |
| Broker popup (FU / engagement / nudge / tier / owner / WhatsApp) | `components/BrokerModal.jsx` | ✓ |
| Member add/edit | `components/UserModal.jsx` + `views/TeamView.jsx` | ✓ real persist via `POST /api/users` / `PATCH /api/users/{slug}` (Admin only) |

## Deploy
1. **Backend (Render):** redeploy the API service. The seed now returns `engagements`
   and `followups` (engagement/followup history); without this redeploy that history
   stays invisible to teammates/admin.
2. **Frontend (Vercel):** set the project **Root Directory** to `frontend` (framework
   preset **Vite**, build `npm run build`, output `dist`). `frontend/vercel.json` has the
   `/api`,`/auth`,`/health` → Render rewrites.
3. Deploy, then smoke-test on the vercel.app URL: Google login, each view, log an
   engagement and confirm a second user/admin sees it.

The old `crm.html` has been deleted; this directory is the only frontend.
