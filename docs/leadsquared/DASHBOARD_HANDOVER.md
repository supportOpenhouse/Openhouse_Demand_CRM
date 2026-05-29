# LSQ Demand Dashboard — Handover (read this first if continuing in a new session)

Self-contained operational guide for the **LSQ Demand Analysis dashboard** subsystem.
Pair with `HANDOVER.md` (LSQ ops history) and `CAPABILITIES.md` (LSQ API matrix).

---

## 0. TL;DR

- **Live, auth-gated dashboard:** https://oh-lsq-demand-dashboard.netlify.app
  Google sign-in restricted to **@openhouse.in** (server-verified). Data is NOT in the
  public HTML — it is served only by an auth-checked Netlify function.
- **Netlify project:** `oh-lsq-demand-dashboard`, site id `2279248a-ea9c-4b8a-ad7a-f455027e9e52`,
  team slug `akshit-wt3wtsq` (team id `6983307801575007626a4113`).
- **Output Google Sheet (mirror):** `LSQ Demand Analysis`
  `1JJt4rGX_qFcS0UYnUm1a2LCxrCIs58IDWseimGQ9fo4`
- **Build = local Python pipeline → /tmp bundle → auth-shell → deploy from `dm_site/`.**
- **Service account** (Sheets read + write to output sheet):
  `/Users/akshit.chaudhary/Documents/Claude Code/Property level report/credentials/service_account.json`
  email `sqlanalytics@polished-logic-434606-g3.iam.gserviceaccount.com` (user has shared all
  relevant sheets with it).
- **Google OAuth client id** (sign-in): `548383854454-unmiq03djs8rhoqr9ot2747huthok1rj.apps.googleusercontent.com`
  (authorized JS origin = the netlify URL; consent screen must be Internal/Production for all staff).

---

## 1. Data pipeline (run in this order)

All scripts live in `/Users/akshit.chaudhary/Documents/Claude Code/leadsquared/`.
Creds: `.env` (LSQ_ACCESS_KEY / LSQ_SECRET_KEY / LSQ_API_HOST + async keys). Never echo/commit.

| Step | Script | Purpose | ~Time |
|---|---|---|---|
| 1 | `_dm_extract_lsq.py` | Pull LSQ event-12001 visits, 215 nego, 221 AVFU, users, **tasks (49 users ×2 status — SLOW ~30 min)** → `/tmp/dm_*.json` | ~30–45 min |
| 1b | (inline in session) events 216/217/220 → `/tmp/dm_booking.json /dm_ats.json /dm_payment.json` | booking/ATS/payment | ~1 min |
| 2 | `_dm_extract_sheets.py` | Pull 5 Google sheets via SA → `/tmp/dm_sheet_*.json` (+ `dm_sheet_cp_owner.json` = Broker_data_query `LeadSquare` tab) | ~1 min |
| 2b | property-status pull (inline) → `/tmp/dm_propstatus.json` | Property ageing sheet `Property Status` tab | ~10 s |
| 3 | `_dm_engine.py` | Compute the 5-tab analytical model → `/tmp/dm_results.json` | ~30 s |
| 4 | `_dm_dashdata.py` | Assemble dashboard bundle (raw visits + brokers + tables) → `/tmp/dm_dashboard_data.json` | ~10 s |
| 5 | `_dm_enrich.py` | Add per-visit pipeline intent, funnel rows, lsq remarks, propstatus → rewrites `/tmp/dm_dashboard_data.json` | ~15 s |
| 6 | `_dm_build_authsite.py` | Transform `dashboard_template.html` → data-less auth shell; assemble `dm_site/` | ~2 s |
| 7 | Deploy (see §4) | Upload `dm_site/` to Netlify | ~2 min |
| (opt) | `_dm_sheet_mirror.py` / `_dm_summary.py` / `_dm_write.py` | Mirror tables into the output Google Sheet | — |

**One-shot refresh (after step-1 caches exist):**
```
cd "/Users/akshit.chaudhary/Documents/Claude Code/leadsquared"
python3 _dm_engine.py && python3 _dm_dashdata.py && python3 _dm_enrich.py && python3 _dm_build_authsite.py
# then deploy from dm_site/ (see §4)
```
Hourly-cheap path = re-pull only sheets + event-12001 (skip the 30-min task scan); daily = full.

---

## 2. Data sources

**LSQ** (`/v2/ProspectActivity.svc/RetrieveRecentlyModified`, POST, accessKey/secretKey qs):
- event **12001** = Demand Deal *visit* (mx_Custom_28=visit date, mx_Custom_4=buyer,
  mx_Custom_5="Broker: .. | Broker Ph: .. | CP Code: .." (CP code often TRUNCATED — unreliable),
  mx_Custom_24=Pipeline Status Hot/Warm/Cold/Dead, mx_Custom_15=city, mx_Custom_37=sales mgr,
  mx_Custom_42=unit+society, mx_Custom_36=Sales feedback, mx_Custom_35=Latest communication,
  RelatedProspectId=lead).
- **221** Demand-After Visit Follow Up (`Status` field = Not Interested/Follow Up/Need to Visit More
  Properties/Revisit/Future Prospect/Booking Done/Negotiation Meeting; mx_Custom_3 = post-FU intent).
- **215** Demand-Negotiation · **216** Booking Done · **217** ATS Signed · **220** Payment.
- AVFU dense only from ~Apr-2026; first LSQ 12001 created 2026-03-20 (LSQ-era).
- Tasks: `/v2/Task.svc/Retrieve` per user (`Buyer- After Visit Follow Up`, `Buyer- Re-Visit Follow Up`,
  `Buyer- Negotiations`, `Regular Interaction Call -CP`, `Buyer- Phone Call`/`Follow Up Call`).

**Google Sheets (read via SA):**
| Name | ID | Tab used |
|---|---|---|
| Visitors data (visit spine) | `17eEX021t97pGnJasMJ6v7ERE0jezKEC0S8teKepJRWQ` | `Sheet1` (7,210 rows; status=completed) |
| Broker_data_query | `1bUkpfbceA7lLpMhRh2aoB-oGCwnzUiyD4sIclm25Z1k` | `Sheet1` (onboarding/added_by/city), `LeadSquare` (cp→CP owner=Lead Owner) |
| Visitors form responses | `1Gclly9_BeHy8KysQrj6M6DCkK_VqSbpDov17H185l4s` | `Responses` (qualitative) |
| property master (historic live) | `16VriaamcwNIVTFYFWx4cWz0L1d826sPcsB-ukIkBc28` | `Property Master` |
| live inventory | `1w8N63xMJJQwgz0mtNWbtpoOfU_PkYF_t5_jM9nMnCuQ` | `Total count of Properties` |
| Property ageing | `127SOgmUuTVoeoU0uHWm0LjzHNSyZWAttWlFn93ybLAs` | `Property Status` (gid 1825009090) |

**Key model facts:**
- **Visit spine = Visitors-data sheet `status==completed`** (the complete set; LSQ is a ~1:1
  downstream mirror — do NOT sum LSQ+sheet, it double-counts). Month = `visit_date`.
- Visit `unit` = **`unit_address_line2` (tower/block) + ' ' + `unit_address_line1` (flat)** → "Tower×Unit".
- `lead_key` = buyer identity for revisit (2nd+ completed visit, chrono).
- Pipeline intent per visit = AVFU mx_Custom_3 (preferred) → 12001 mx_Custom_24 → Unknown.
- CP owner = LSQ Lead Owner (LeadSquare tab); onboarding credited to `added_by`. Exclude
  Prashant Singh (`prashant@openhouse.in`) from task-completion.

---

## 3. Bundle (`/tmp/dm_dashboard_data.json`) → embedded as `_data.json` in the function

Keys: `months, cpo_months, fm_mau, fm_dau, fm_stick, fm_cohort_ret, fm_perprop, cohort,
cp_owner, intent, stopped, brokers[], visits[], lsq_funnel[], funnel_meta, propstatus{headers,rows}, kpi`.
- `visits[]`: date,month,cp,broker,company,city,buyer,buyer_contact,sm,society,unit,owner,onb,
  lead_key,revisit,pstatus,src,added_by,first_added_by,lead_status,pi,remarks.
- `brokers[]`: cp,name,company,city,owner,added_by,onb,total,last_active,status, monthly cols, pis[].
- `lsq_funnel[]`: m,city,cp,owner,pi,avfu,st,fwd,park,out,revisit,nego,booking,ats,pay.

---

## 4. Deploy (auth-gated) — CRITICAL PROCEDURE

`dm_site/` is the ONLY thing deployed. Built by `_dm_build_authsite.py`:
```
dm_site/
  netlify.toml                       publish="public"; functions; included_files
  public/index.html                  auth shell — NO data embedded
  netlify/functions/data.mjs         verifies Google token → returns gzipped bundle
  netlify/functions/export.mjs       verifies token → SA writes filtered data to a new sheet tab
  netlify/functions/_data.json       the bundle (server-only; included_files; NEVER in publish)
  netlify/functions/_sa.json         service-account key (server-only; included_files)
```
Deploy command pattern (run **from `dm_site/`**, never repo root — root has `.env`/creds):
1. Call Netlify MCP `netlify-deploy-services-updater {operation:'deploy-site', params:{siteId}}`
   → returns an `npx @netlify/mcp ... --proxy-path "<TOKEN>"` command. **The proxy token is
   single-use & expires fast; copy it EXACTLY (do not truncate) into a /tmp script and run it.**
2. `cd dm_site && npx -y @netlify/mcp@latest --site-id 2279248a-... --proxy-path "<full token>"`
3. The Netlify CLI is NOT logged in; the MCP proxy token is the only auth path available here.

**Post-deploy security verification (always run):**
```
U=https://oh-lsq-demand-dashboard.netlify.app
curl -s -o /dev/null -w '%{http_code}' -X POST $U/.netlify/functions/data -d '{}'   # expect 401
curl -s -o /dev/null -w '%{http_code}' -X POST $U/.netlify/functions/export -d '{}' # expect 401
for p in _data.json _sa.json .env netlify/functions/_sa.json dm_dashboard_data.json; do
  echo $p $(curl -s -o /dev/null -w '%{http_code}' $U/$p); done   # ALL must be 404
```

---

## 5. Dashboard tabs & filters

**Tabs:** Overview · Visits Analysis · Brokers · Cohorts · Segments · Funnel · Property Status ·
CP Owners · Key Product Metrics · Raw Data · Summary & Recs.
**Global filters (all tabs, in `F`):** City, CP Owner, Month from/to, Search, Segment (multiselect
9 behavioural segs), Pipeline status, Sales Manager, Source, Lead status, Society, Unit
(society-dependent dropdown). `Reset` clears all. Visits-Analysis rows cross-filter via
`setFilter(kind,val)` (toggle).

**Critical UI bug pattern:** the whole app is wrapped in `function boot(D){…}` for the auth flow,
so inline `onclick=` handlers (which run in GLOBAL scope) MUST be exposed:
`_dm_build_authsite.py` appends `window.dlCSV=… window.openSheets=… window.setCohMode=…
window.toast=… window.setFilter=…`. **Any new inline-onclick function must be added there.**

Other gotchas: bundle >6 MB → `data.mjs` gzips response (browser auto-decompresses). Preview
screenshots sometimes clip to the sidebar (narrow viewport) — trust `preview_eval` DOM checks,
not the screenshot. Template is `dashboard_template.html`; rebuild via `_dm_build_authsite.py`
after every edit; JS-compile check with `new Function(script)` before deploy.

---

## 6. Definitions (locked with user)
Active broker=≥1 completed visit/mo. Churn lists at 1/2/3-mo zero windows. Retention=cohort
triangle + MoM carryover. Revisit=2nd+ completed visit/lead. Funnel=unique LSQ-era visits;
Forward=Revisit/Nego/Booking status, Out=Not-Interested+Dead, Parked=Follow-up/Need-more/Future;
leak="expected next LSQ action not recorded". May-26 is partial (to 18th) — always footnote.

---

## 7. Automation — CHOSEN PATH: Google Cloud Run (user manages GCP)

Scaffolded in `automation/cloudrun/` (GitHub-Actions scaffold in `automation/` is the
fallback only). Decisions: project `polished-logic-434606-g3`, region `asia-south1`,
runtime SA `sqlanalytics@polished-logic-434606-g3.iam.gserviceaccount.com`, LSQ keys in
**Secret Manager**, store = **new PRIVATE GCS bucket** `oh-lsq-dashboard-data`.

Architecture: **Cloud Scheduler** (2 cron: hourly `0 * * * *`, daily `30 21 * * *` ≈3am IST)
→ **Cloud Run Job** `lsq-dashboard-pipeline` (one image, `MODE` env hourly|daily,
task-timeout 3600s for the ~50-min daily scan, runs AS the SA via ADC — no key file) →
writes gzipped bundle to `gs://oh-lsq-dashboard-data/dm_bundle.json.gz` (daily also
`dm_caches.tgz`) → Netlify `data.gcs.mjs` (auth-gated @openhouse) fetches that PRIVATE
object via the bundled `_sa.json` (JWT→token), 15-min cache, fallback to baked `_data.json`.
**No Netlify redeploy for data**; redeploy only for code (≤1/day, manual/build hook).

Files: `automation/cloudrun/{run.py, Dockerfile, deploy.sh, data.gcs.mjs}`,
`automation/_dm_extract_sheets_adc.py` (ADC sheets), root `.gcloudignore` (security:
excludes .env/_sa.json/snapshots/dm_site from the build context).

### Deploy.sh run-state (2026-05-18 session — pipeline VERIFIED running)
`akshit@openhouse.in` rights on `polished-logic-434606-g3`: project `roles/editor` +
`roles/iam.serviceAccountUser` (actAs ANY project SA) + `roles/cloudscheduler.admin`.
CAN: enable APIs, create bucket, build, deploy job, run job, create/update schedulers.
CANNOT: any `setIamPolicy` (project, secret, **or job-level run.jobs.setIamPolicy**).
deploy.sh design: LSQ keys → **Cloud Run env vars** from local `.env` (not Secret Manager —
IAM not grantable; visible to run.jobs.get holders, acceptable internally); build via
`automation/cloudrun/cloudbuild.yaml` (`gcloud builds submit --config`, `-f` invalid);
runtime SA = `sqlanalytics@` (GCS objectAdmin on bucket + Sheets via ADC).

**CONFIRMED WORKING:** APIs, private bucket, AR repo `lsq`, Cloud Build (~54s),
`gcloud run jobs deploy`, job execution, AND the scheduler→job invocation path.

**3 container-port bugs found & FIXED this session** (scripts did relative-path reads of
files `.gcloudignore` correctly strips for security — so they worked locally, broke in
the image; each fixed to fall back to the cloud path, local behaviour unchanged):
1. `_dm_extract_lsq.py:11` — bare `open('.env')` → fallback to `LSQ_*` env vars
   (matches the pattern siblings `_dm_extract_events.py`/`_visits_only.py` already had).
2. `automation/_dm_extract_propstatus.py` — fell back to a hardcoded local SA-file path
   → reworked ADC-first (mirrors `_dm_extract_sheets_adc.py`); runs as job SA on Cloud Run.
3. `_dm_extract_lsq.py:76` — `json.load(open('snapshots/raw/users.json'))` → 3-way:
   local snapshot → live `Users.Get` → **baked `automation/users_seed.json`** (49-user
   copy of snapshots/raw/users.json, included via `.gcloudignore !automation/**`).
Rebuild + redeploy after ANY `_dm_*`/automation script edit (code is baked into the image).

ℹ️ **LSQ `/v2/UserManagement.svc/Users.Get` outage (2026-05-18) — RESOLVED same day.**
It 500'd server-side (`MySqlException`, "contact administrator"), reproduced from BOTH
Cloud Run and the Mac, persistent across 4 retries → that day's seed used the baked
fallback. Re-tested later 2026-05-18: **200, 50 users, 0.5s — healthy again.** The Cloud
Run pipeline tries live first, so it self-healed automatically (no redeploy needed); the
next run uses live data. It is the ONLY users-list endpoint (HANDOVER.md:107; `Users/Get`
404s) so the baked-seed fallback stays as the safety net for future outages. **TODO
(low-pri): refresh `automation/users_seed.json`
(`cp snapshots/raw/users.json automation/users_seed.json` → rebuild) — seed is Apr-30 (49),
live is now 50; only matters if LSQ breaks again before the next image rebuild.**

**Scheduler invoke identity (KEY FINDING):** runtime SA `sqlanalytics@` has NO `run.*`
role and job-level `run.jobs.setIamPolicy` is NOT grantable, so a scheduler authenticating
as it would 403. FIX: both Cloud Scheduler jobs authenticate as the **default compute SA**
`<projNum>-compute@developer.gserviceaccount.com` (here `561394753846-compute@…`), which
already holds `roles/run.admin` + `roles/run.invoker` by default; akshit actAs it via
project-level serviceAccountUser. deploy.sh §8 now derives & uses it (create-or-update,
idempotent — repairs the OAuth SA on pre-existing scheduler jobs). The job's RUNTIME
identity stays `sqlanalytics@`. Verified: a forced `scheduler jobs run lsq-hourly`
created a live Cloud Run execution (auth path good). Both crons ENABLED.

STATUS: schedulers live (hourly `0 * * * *`, daily `30 21 * * *` UTC). Daily seed re-run
(post-fix image) IN PROGRESS to write `gs://oh-lsq-dashboard-data/dm_bundle.json.gz`
(+ `dm_caches.tgz`); hourly mode needs `dm_caches.tgz` so first successful daily must land
before any hourly succeeds (failed hourly = harmless, site serves baked bundle meanwhile).
gcloud SDK on this Mac: `~/Downloads/google-cloud-sdk/bin` (not on non-login PATH).
(Unused Secret Manager secrets LSQ_* versions exist — harmless; delete later if wanted.)

### To go live (gcloud IS authed as akshit@ via `~/Downloads/google-cloud-sdk/bin`)
1. `bash automation/cloudrun/deploy.sh` from project root — enables APIs, makes the private
   bucket, reads 3 LSQ keys from local `.env` → Cloud Run env vars (NOT Secret Manager),
   bucket+actAs IAM, builds image, deploys the Job, **seeds once (daily, `--wait` ~50min)**,
   creates/updates the 2 Scheduler crons. Re-runnable & idempotent. (Image already built &
   deployed this session; the GCP infra steps are all done — re-run only after code edits.)
2. Netlify → Site env vars: add `GCS_BUCKET=oh-lsq-dashboard-data`. Replace
   `dm_site/netlify/functions/data.mjs` with `automation/cloudrun/data.gcs.mjs` (keep
   `_sa.json` bundled), do ONE deploy via §4 procedure. Data then self-refreshes.
3. (opt) Netlify build hook for daily code redeploys.
Until step 2, live site = baked bundle (safe, unchanged).

### (fallback) GitHub-Actions design (decisions locked with user)

Decisions: **GitHub Actions cron** · new **private repo** (scaffold) · **NO hourly Netlify
redeploy** (max 1 redeploy/day, code-change only) · visits hourly, rest daily.

**Core idea — decouple data refresh from deploy.** The Netlify static deploy stays fixed;
data freshness comes from the auth function fetching a frequently-updated bundle at runtime:

```
GitHub Actions (cron)                Google Drive                 Netlify (no redeploy)
  hourly: light extract  ──build──▶  dm_bundle.json.gz  ◀──fetch── data.mjs (SA-auth, 15-min
  daily : full  extract  ──build──▶  (SA-owned file)               in-mem cache) → gzip → client
```

- `data.mjs` reworked: after Google-token auth, **download the Drive bundle file via the
  bundled SA key** (`_sa.json`), cache in memory ~15 min, gzip, return. Fallback to the
  baked `_data.json` if Drive fetch fails. → hourly-fresh data, zero redeploys.
- **Netlify redeploy only for CODE changes** (template/functions): manual, via a **Netlify
  build hook** URL. Bundle is NEVER committed (so it never triggers a build).
- Repo scaffold (in `automation/` now; user pushes to a new private GitHub repo):
  ```
  pipeline.py            # orchestrates _dm_* scripts; --mode hourly|daily; uploads bundle to Drive
  requirements.txt
  .github/workflows/refresh-hourly.yml   # cron '0 * * * *'  -> pipeline.py --mode hourly
  .github/workflows/refresh-daily.yml    # cron '30 21 * * *' (≈3am IST) -> pipeline.py --mode daily
  (scripts _dm_*.py, dashboard_template.html, _dm_build_authsite.py copied in)
  .gitignore  # excludes .env, credentials, /tmp, *_sa.json
  ```
- **GitHub secrets:** `LSQ_ACCESS_KEY`, `LSQ_SECRET_KEY`, `LSQ_API_HOST`,
  `GS_SA_JSON` (full service-account JSON), `DRIVE_BUNDLE_FILE_ID` (the Drive file id).
- **hourly mode** = pull Visitors sheet + LSQ event-12001 + Property-Status sheet only →
  engine(light)/dashdata/enrich → gzip → Drive upload (~3–4 min, well within Actions limits).
- **daily mode** = full extract incl. the ~30-min task scan + AVFU/215/216/217/220 +
  brokers/cohorts/funnel → Drive upload. Also the only time code is (optionally) redeployed
  via the build hook if the template changed.
- Drive bundle file: create once via SA (Drive `files.create`, JSON, share not needed —
  SA owns it). Store its id as `DRIVE_BUNDLE_FILE_ID`. `data.mjs` uses Drive `files.get?alt=media`.

### ⛔ BLOCKERS confirmed (owner-only actions; agent cannot do these)
- **Google Drive API is DISABLED** for SA project 561394753846. Enable it once:
  https://console.developers.google.com/apis/api/drive.googleapis.com/overview?project=561394753846
  Until then the Drive-backed `data.drive.mjs` / `pipeline.py --init-drive` cannot work
  (SA Sheets access is fine). Alternative if you'd rather not enable Drive API:
  use **Netlify Blobs** as the runtime store (GH Action POSTs bundle to an authed
  ingest function → `data.mjs` reads the blob); needs a Netlify token in CI. Either
  way the live site is safe meanwhile (serves baked `_data.json`).
- **`gh` CLI not installed + not a git repo + root .gitignore does NOT exclude
  `snapshots/` or `dm_site/netlify/functions/_sa.json`.** A naive push would LEAK the
  SA private key + PII. GitHub repo creation, secret upload, and the first push are
  **owner-only** (need your GitHub auth; you must deliberately propagate the SA/LSQ
  secrets). Before any push: write a ROOT `.gitignore` excluding `.env`, `snapshots/`,
  `**/_sa.json`, `**/service_account.json`, `/tmp`, `*.json` caches, then `git status`
  to verify zero secrets staged.
- **Netlify build hook**: UI-only (no MCP/API) — create in Netlify site settings.

### Remaining MANUAL steps for the user (cannot be automated from here)
1. Create a **private GitHub repo**; push the `automation/` contents.
2. Add the 5 GitHub **secrets** above (SA JSON from the Property-level-report creds path).
3. Create the **Drive bundle file** (run `automation/pipeline.py --mode daily --init-drive`
   once locally — it creates the file & prints the id) → put id in `DRIVE_BUNDLE_FILE_ID`.
4. Create a **Netlify build hook** (Site config → Build & deploy → Build hooks) for
   manual/daily code redeploys; keep it out of CI unless code auto-deploy is wanted.
5. Swap live `data.mjs` to the Drive-backed version (`automation/data.drive.mjs`) and do
   ONE final manual deploy via the MCP proxy procedure (§4). After that, data self-refreshes.

Until step 5, the site serves the baked bundle (current behaviour) — safe.

---

## 8. Open items
- [ ] Automation infra decision (GitHub Actions vs Mac launchd vs other) — blocking.
- [ ] Non-interactive Netlify deploy (build hook / PAT) to replace MCP proxy token.
- [ ] User to confirm authed data load works after gzip change & "Open in Sheets" write.
- [ ] Tower×Unit fix applied in `_dm_dashdata.py` (this session) — rebuild+deploy pending.
- [x] **UI batch 1 — DEPLOYED & LIVE 2026-05-19** (verified byte-identical to dm_site build,
  security checks pass): (1) Property Status frozen cols — root cause was the flexbox
  `min-width:auto` bug on `#main` (added `min-width:0`) + `#tPS` `border-collapse:separate`
  + pinned frozen th/td widths; (2) Visits-Analysis Month/Week/Visit-date cards sort by key
  desc (`vaCard` `opts.sortKey:'k'`); (3) "Society · Unit (Tower)" vaCard; (4) VA-only Date
  from/to `#fD1/#fD2` (filter only inside `va()`); (5) 8 string filters → searchable
  comboboxes (`.ms.ss`; native select hidden & kept as source-of-truth).
- [x] **UI batches 2+3 — DEPLOYED & LIVE 2026-05-19** (deployed together via §4; verified
  byte-identical to local dm_site build, all changes present, security 401/404 pass, no PII).
  Details of batch 2 below; batch 3 in the bullet that follows.
- [x] **UI batch 2 (LIVE)** — (a) **double-filter bug fixed** — root cause
  was `boot(D)` running twice (GSI `onCred` can fire 2×) → `makeSearchable` re-wrapping →
  2 `.ms-h`/filter; fix = idempotent `makeSearchable` (`sel.__ss` cache) + `boot()` once-
  guard `window.__booted` + `onCred` `window.__authing` guard (both in `_dm_build_authsite.py`);
  (b) Cohorts tab: new **activated-base retention triangle** `#tCohA` (Size = brokers in
  cohort with ≥1 visit ever, e.g. 40 of 98 for 2025-08; cells = % of those active/mo;
  `actRetData()`/`heatTri()`); (c) **broker→property spread** cohorts last-3-mo
  (`M.slice(-3)` = 2026-03/04/05): `#tSprU` distinct society|unit buckets 1/2/3/4/5+,
  `#tSprS` distinct-society buckets; per-broker CSV via `spreadDetail()` →
  tableFor `spread_unit`/`spread_soc`/`cohortret_act`. Spread cohorts ignore the filter
  bar (consistent w/ existing Cohorts tab). Standalone preview = `_preview/index.html`
  (local only, full PII, gitignored/.gcloudignore'd; `dash` cfg serves :8801).
- [x] **UI batch 3 (LIVE 2026-05-19)** — **`_dm_dashdata.py` now emits `visits_extra`
  (non-completed); future bundle regen = `python3 _dm_dashdata.py && _dm_enrich.py` (caches
  in /tmp), or the Cloud Run job which runs the same scripts.**
  (a) Daily-visits chart: +Ghaziabad line, retitled, Chart.js `interaction:index`+`tooltip`
  enabled in `chart()` (hover shows values, all charts); (b) **Funnel validated** — starting
  number = `funnel_meta.sheet_unique_visits_lsqera`=2,831 (unique LSQ-era *completed* sheet
  visits = spine). It is NOT a strict nested funnel: Nego/Booking/ATS/Pay come from indep.
  LSQ events 215/216/217/220 so "% of prev" can exceed 100% (was 170%). Added single
  consistent base `pct_start`=Count/2831, explicit start caption, kept `pct_prev` labelled
  "(info)"; flow-chart now labels each node "% of start"; (c) **VA-only visit-status filter**
  `#fVStat` (completed default / all / cancelled / upcoming). `_dm_dashdata.py` keeps
  `visits`=completed (spine for EVERY tab/broker/kpi/cohort unchanged) + new `visits_extra`
  = cancelled+upcoming (date falls back to `selected_date`; 1,622 rows; `_dm_enrich.py`
  also attaches `pi` to them but NOT broker pis). Only `va()` reads `visits_extra`/`F.vstat`
  — verified other tabs stay 5,588 completed when status=all; (d) **owner/SM city inferred**
  client-side from D.visits (modal city of CPs they own → SM visits) — Unknown owners 28→18
  (10 resolved e.g. Joginder Singh→Gurgaon); `inferOwnerCity()` in template, no engine
  change; (e) Cohorts: **rolling-3mo activated %** triangle `#tCohA3` (`actRet3moData()`,
  active in m or m-1 or m-2); (f) **renamed "OH Demand Dashboard"** + OpenHouse logo
  (Drive "Complete logo.svg" id 1RMrf5PWmNNHA6eq01UX4bW0Vpeo7n9lg, inlined base64 in
  sidebar h1 + auth gate). All 11 tabs render, JS-checked, 0 console errors, shell no PII.
- [ ] Optional: mirror Funnel / Visits-Analysis / Property-Status / May-summary into the sheet.
- [ ] Looker "Apartment/config" filter not built (no config column in visits source).
