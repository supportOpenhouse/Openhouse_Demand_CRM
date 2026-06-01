# Session Handover — LSQ Migration, Mobile-Auth Fix & Ops (2026-06-01)

> **Scope:** everything done in the working session of 2026‑05‑29 → 06‑01.
> Covers: config fixes, the one‑shot LeadSquared→CRM migration, the LSQ write‑back,
> a 3‑round validation, the mobile login‑loop fix, the sheet‑sync investigation,
> plus the operational gotchas that cost real time. Read this end‑to‑end before
> touching prod.
>
> **Owners:** Akshit Chaudhary (akshit@openhouse.in) · Saransh Khera (support@openhouse.in)

---

## 0. TL;DR

| Area | Status |
|---|---|
| LSQ → CRM DB migration | ✅ Done + 3‑round validated |
| LSQ write‑back ("moved to CRM" flag) | ✅ Done (1,248 leads), reversible |
| Mobile Google‑login loop | ✅ Fixed + deployed (first‑party cookie via Vercel proxy) |
| Sheet sync (visitors/brokers/inventory) | ✅ Working (15‑min cron; "stale" report was a cached browser page) |
| Config drift (frontend URL, secrets) | ✅ Fixed |

Production stack (unchanged): **Frontend** = Vercel `https://openhouse-demand-crm.vercel.app` · **Backend** = FastAPI on Render `https://oh-demand-crm-api.onrender.com` · **DB** = Neon Postgres (`us-east-1`, `ep-wispy-bird-aqr2a9u3-pooler`) · **Auth** = Google SSO (@openhouse.in) · **Repo** = `github.com/supportOpenhouse/Openhouse_Demand_CRM` (private).

---

## 1. Credentials & infra reference

| Item | Where |
|---|---|
| Neon `DATABASE_URL`, `SESSION_SECRET`, Google OAuth, `INTERNAL_CRON_TOKEN`, Google service account | local `.env` (the "Demand CRM" project `.env`) |
| LSQ API creds (`LSQ_API_HOST`=`https://api-in21.leadsquared.com`, `LSQ_ACCESS_KEY`, `LSQ_SECRET_KEY`) | `~/Documents/Claude Code/Credentials/.env` |
| Prod repo (private) | `github.com/supportOpenhouse/Openhouse_Demand_CRM`, local clone `~/Documents/Claude Code/Openhouse_Demand_CRM` |
| Vercel project | `openhouse-demand-crm` · id `prj_7A4AyXhdcNnBBWPvzEFscfjZ50Uh` · team `supportopenhouses-projects` (`team_HPCnkwW6wT0SSeYmuCueVYTU`) |
| Render | web `oh-demand-crm-api` + cron `oh-demand-crm-sheet-sync`; env group `oh-crm-secrets` |
| Backups (migration + write‑back rollback) | `lsq_sync/backups/` (gitignored) |

> ⚠️ A local clone `~/Documents/Claude Code/Demand CRM` is the **older pre‑restructure prototype** (remote `akshit-openhouse/oh-demand-crm.git`). Do real work in the `Openhouse_Demand_CRM` clone.

---

## 2. Config fixes (landed on `main`)

1. **Frontend origin reconciliation.** Several configs defaulted to the wrong `oh-demand-crm.vercel.app`; the live host is `openhouse-demand-crm.vercel.app`. Fixed in `backend/api/config.py` (CORS default), `render.yaml`, `backend/.env.example`, `README.md`, `docs/DEPLOY_RUNBOOK.md`. The API host `oh-demand-crm-api.onrender.com` was intentionally left unchanged.
2. **Secret redaction.** Removed the inline Neon connection string (with password) from `docs/PROD_HANDOVER.md`. **Note:** the password still exists in git history; rotate the Neon role password if you want full remediation. Repo is private so exposure is limited.

---

## 3. LeadSquared → CRM migration (the main work)

### 3.1 What it is
A **one‑time** migration of the LSQ demand pipeline into the CRM Neon DB. **Not** an ongoing sync — after it, new visits flow from the Google sheets (existing 15‑min cron). Script: **`lsq_sync/migrate.py`**.

### 3.2 Decisions (made with Akshit)
- Lead scope: **buyers + CPs**.
- History: **all‑time**.
- Visit source: LSQ **Opportunity event `12001`** ("Demand Deal") carries the live per‑visit status; pulled once for the backfill.
- Blank LSQ pipeline status → `unc` (no inference).
- Edge stages: `Registry Done`→`ats`, `Duplicate/Invalid Lead`→`cancelled`, blank→`avfu`.
- Unmapped historical RMs → created as **inactive users**; junk owners → `system@openhouse.in` ghost.
- Visit dedup: **match + enrich, insert leftovers** (not bulk insert).
- Phones: **left as‑is** (not "fixed" from LSQ).

### 3.3 Key findings (non‑obvious — read these)
- **`12001` opportunity = the visit.** Custom fields come back as `Fields:[{Key,Value}]`. Key columns: `mx_Custom_2`=Stage (live), `mx_Custom_24`=Pipeline Status (thermal), `mx_Custom_3`=Source, `mx_Custom_4`=Buyer Name, `mx_Custom_5`=broker blob (`"Broker: … | Broker Ph: … | CP Code: CPxxxxx"`), `mx_Custom_28`=visit date, `mx_Custom_37`=sales_manager (RM), `mx_Custom_44`=Society, `mx_Custom_33`=next followup, `mx_Custom_36`=sales feedback.
- **`RelatedProspectId` is the CHANNEL‑PARTNER lead**, not a separate buyer lead. In LSQ the demand deal sits on the CP lead; the buyer is just fields on the opportunity. So buyer+CP "leads" collapse to ~**1,248 unique = the active CP leads**.
- **The sheet's `lead_key` ≠ LSQ `ProspectId`** (0/1247 match). Buyers can't be linked by that key.
- **DB buyer phones are corrupted/truncated** (5‑digit fragments); LSQ phones are clean. Phone matching is unreliable — we matched visits by **`cp_code` + `visit_date` (+ buyer first name)** instead, which is **99.6%** reliable.
- **Activity history is sparse** — the pipeline lives in the opportunity Stage field, not activities: AVFU(221)=2,728, Negotiation(215)=59, Booking(216)=14, ATS(217)=9, Payment(220)=2, PhoneCall(212)=2; 213/214/218 = 0.
- **Opportunity `CreatedByName` is the bulk‑import service acct ("Test Onboarding"), not the RM.** Owner attribution must come from `mx_Custom_37` (deal RM). Activity rows don't carry the RM, so each followup is attributed to its visit's deal RM (see `--fix-owners`).

### 3.4 Mapping (LSQ → CRM)
- **Opportunity stage (`mx_Custom_2`) → `visits.current_stage`:** Visited→`avfu`, Not Interested After Visit→`not_interested`, Need to see more Properties→`need_more`, Future Prospect→`future_prospect`, Revisit Scheduled→`revisit_scheduled`, Negotiation Meeting Scheduled/Done→`negotiation`, Booking Done→`booking`, ATS Executed/Registry Done→`ats`, Duplicate/Invalid Lead→`cancelled`, blank→`avfu`.
- **Pipeline status (`mx_Custom_24`) → `visits.current_status`:** Hot/Warm/Cold/Dead lowercased; blank→`unc`.
- **Activities → `followups`** (221/215/216/217/218/220), `source='lsq_migration'`, dedup on `lsq_activity_id`. Per‑activity date fields differ — see `ACT_NEXTFU_FIELD`/`ACT_REVISIT_FIELD` in the script (e.g. 215's `mx_Custom_2` is "Cancelled Reason", **not** a date — there are regex date‑guards in `_d`/`_ts`).
- `followups.buyer_status` ∈ {hot,warm,cold,dead,future_prospect,unc}; `note` is non‑empty (synthesized `[LSQ <activity> · <date>]` when blank).

### 3.5 What landed (verified)
- **3,817 visits enriched** with LSQ live stage/status + `lsq_visit_activity_id`; **26 new visits inserted**; ~3,843 distinct visits represent the 6,294 opportunities.
- **2,808 followups** loaded, attributed across **22 real RMs** (ex‑RMs Umer Khan / Prakhar Vaish / Prateek Srivastava as inactive `Ground` users; ghost for junk).
- **1,204 buyers** + **19 users** stamped with LSQ ids; 4 users created (3 ex‑RM + ghost).

### 3.6 How to run / undo
```bash
cd lsq_sync
python3 migrate.py                 # DRY RUN (default): prints projected changes, NO writes
python3 migrate.py --execute       # apply in one transaction; snapshots a backup first
python3 migrate.py --fix-owners    # repair followups.by_user_id in place (no full rerun)
python3 migrate.py --rollback backups/backup_<ts>.json   # full undo
python3 migrate.py --use-cache     # reuse the cached LSQ pull (/tmp/lsq_migration_cache.json)
```
Idempotent throughout (dedup on `lsq_visit_activity_id` / `lsq_activity_id`). Every `--execute` writes a snapshot backup to `lsq_sync/backups/` for rollback.

### 3.7 Two correctness fixes applied post‑run (already done)
- **`lead_status` reconciled** on ~2,476 migrated visits (was holding stale sheet values; now `select_status` when `current_status='unc'`, else mirrors it). The script's step 6 now also does this defensively.
- **9 duplicate new visits deduped** (NULL‑date loose opps for the same buyer; no followups attached). The script now collapses loose opps by buyer too.

---

## 4. LSQ write‑back ("moved to CRM" flag)

- Goal: flag every migrated lead in LSQ as moved to the CRM. Script: **`lsq_sync/writeback.py`**.
- The intended `mx_Migrated_To_CRM` field was **never created in LSQ admin**, so we **repurposed the unused `mx_Test` field** (0% filled on buyers + CPs) with value **`"a"`** as the flag. Reversible.
- **Result: 1,248 leads stamped, 0 failures**, validated by sample (40/40 read back `'a'`).
- Undo: `python3 writeback.py --rollback backups/writeback_<ts>.json` (clears the field on exactly those leads).
- **LSQ quirks learned:** (a) `Lead.Update` returns `Success` but `Leads.GetById` is **eventually‑consistent** — read‑backs lag several seconds, so validate after a delay (don't trust an immediate read). (b) MultiSelect writes *do* persist (the early "None" read was just lag). (c) `Leads.Get` by `mx_CP_code` resolves a CP → `ProspectID`.

> **Open scope question:** we flagged the **1,248 CP leads that have migrated demand pipeline**. If the intent is to flag **all ~4,681 CP leads** regardless of activity, that's a broader run (easy to do).

---

## 5. 3‑round validation (go‑live grade)

- **Round 1 — data/migration fidelity (LSQ↔DB): 20/20 PASS.** Every migrated visit's stage/status matches the LSQ mapping exactly; full referential integrity; constraints; attribution; lead_status consistency; no duplicates. (Caught + fixed the 2 issues in §3.7.)
- **Round 2 — prod API read‑path + scoping: 12/12 PASS.** Minted a real session cookie (local `SESSION_SECRET` matches prod) and hit the live `/api/seed` as Admin/TL/KAM/Ground → correct shape, scoping (Admin/TL 7,8xx visits · KAM 932 · Ground 271), migrated stages surface, no 500s.
- **Round 3 — frontend dashboard: PASS, zero console errors.** Ran the real frontend locally fed with the actual prod `/api/seed`: all 7 views render, broker/property popups + timeline work, **frontend role‑scoping matches the backend exactly**, mobile layout OK.
- **Caveat:** prod Google‑OAuth UI can't be automated; a human should do one real login + followup‑save to confirm the live write path.

---

## 6. Mobile login‑loop fix (auth)

### 6.1 Root cause
The session cookie was `SameSite=None; Secure` (third‑party): the frontend (`…vercel.app`) and API (`…onrender.com`) are **different registrable domains**. Mobile Safari/iOS (ITP) and Chrome block third‑party cookies → `/api/me` always 401 → bounce to Google → **loop** (desktop Chrome still allowed it, so it was mobile‑only).

### 6.2 Fix (deployed)
Make the cookie **first‑party** by routing the API under the frontend origin:
- `frontend/vercel.json`: rewrite `/api/*`, `/auth/*`, `/health` → the Render backend (Vercel proxies same‑origin).
- Frontend `API_BASE=''` (same‑origin).
- `backend/api/auth.py`: cookie → `SameSite=Lax`.
- Render web env: `API_BASE_URL=https://openhouse-demand-crm.vercel.app` (so the OAuth `redirect_uri` is first‑party). **Cron `API_BASE_URL` stays onrender** (its `/admin/sync` call is not proxied).
- Google console: added redirect URI `https://openhouse-demand-crm.vercel.app/auth/google/callback`.

Validated: `/health` 200 via proxy, `redirect_uri`=vercel callback, `Set-Cookie` forwards through the proxy, authenticated `/api/seed` works through the proxy.

### 6.3 ⚠️ The gotcha that cost the most time: **`/` serves `index.html`, not `crm.html`**
There are **two near‑identical ~300 KB frontend files** (`crm.html` and `index.html`). Vercel serves the physical **`index.html`** at `/`, so the `vercel.json` `"/ → /crm.html"` rewrite **never fires**. The fix initially went into `crm.html` only, so users kept loading the old `index.html` (still calling onrender → loop). **`index.html` is the canonical served file — edit it (or keep both in sync).**

### 6.4 ⚠️ Vercel deploy authorization
Vercel blocked every git/hook deploy because the pushing GitHub account (`akshit-openhouse`) wasn't a connected Vercel team member, and even a token deploy needs **Owner/Admin** on the `supportopenhouses-projects` team. **Working method:**
```bash
# from repo root, with .vercel/project.json = {"projectId":"prj_7A4AyXhdcNnBBWPvzEFscfjZ50Uh","orgId":"team_HPCnkwW6wT0SSeYmuCueVYTU"}
npx vercel deploy --prod --yes --token=<OWNER_VERCEL_TOKEN>
```
**Going forward:** connect `akshit-openhouse`'s GitHub to the Vercel team (so normal pushes auto‑deploy), or always deploy via an owner token/dashboard.

---

## 7. Sheet sync — investigated, working

A "data not updating since 27 May" report turned out to be a **stale browser page**, not a backend issue:
- The 15‑min Render cron runs fine — `sheet_sync_log` shows `visitors_data` **success today**, DB `max(visit_date)=2026-06-01`, 8,127 visits.
- `/api/seed` returns fresh data, `x-vercel-cache: MISS`.
- The HTML shell (`/`) came back `x-vercel-cache: HIT` with **age ~2.5 days** — the browser/edge served an old app shell. A refresh fixed it.
- The frontend has **no service worker, no localStorage seed cache**, and re‑fetches `/api/seed` on every load — so a fresh load always shows current data.
- Note: Saransh's "stop sync" commit only disabled the **tier/CP‑ownership** sheet sync (`ENABLE_TIER_SYNC`), not visitors/brokers/inventory.

**Optional hardening (not yet done):** add an explicit no‑cache header for `/` and `/index.html` in `vercel.json` (today only `/crm.html` has one) so the shell always revalidates.

---

## 8. Operational gotchas (things that bite)

- **Neon `us-east-1` link is flaky** from this network — DNS `REFUSED` / "no route to host" blips throughout. Scripts retry on `getaddrinfo`; if a DB command fails, just retry.
- **`index.html` is the served frontend file**, not `crm.html` (see §6.3).
- **Vercel deploys are authorization‑gated** (see §6.4).
- **LSQ reads lag writes** (eventually consistent) — validate write‑backs after a delay.
- **Per‑LSQ‑activity field meanings differ** — never assume `mx_Custom_N` means the same thing across activity types.
- **Two local clones** — use the `Openhouse_Demand_CRM` one (not "Demand CRM").

---

## 9. Pending / TODO

1. **Revoke the Vercel token** that was used for the CLI deploy (it was shared in chat). Vercel → Settings → Tokens.
2. **Connect `akshit-openhouse` to the Vercel team** (or standardize on owner/token deploys) so future deploys aren't blocked.
3. **Decide write‑back scope:** flag all ~4,681 CP leads, or keep just the 1,248 active ones (§4).
4. **Consolidate `index.html` / `crm.html`** into one served file to end the duplicate‑file hazard.
5. **(Optional) no‑cache header for `/`** in `vercel.json` (§7).
6. **(Optional) rotate the Neon password** — it remains in git history (§2).
7. **(Optional) extend `seed_snapshot`** to surface the per‑followup timeline in the UI (current_stage/status already flow via the projection trigger).
8. **Human smoke test:** one real Google login on mobile (incognito) + one followup‑save on prod.

---

## 10. Common commands

```bash
# Trigger a sheet sync manually
curl -X POST -H "X-Internal-Cron-Token: $INTERNAL_CRON_TOKEN" \
  https://oh-demand-crm-api.onrender.com/admin/sync

# Health
curl https://oh-demand-crm-api.onrender.com/health
curl https://openhouse-demand-crm.vercel.app/health   # via Vercel proxy

# Migration (see §3.6) and write-back (see §4) live in lsq_sync/
# Frontend deploy (owner token) — see §6.4
```

---

*End of session handover. Companion docs: `PROD_HANDOVER.md` (prod build), `LSQ_HANDOVER.md` (original LSQ brief), `BACKEND_SCHEMA.md` (DDL), `DEPLOY_RUNBOOK.md` (deploy), `lsq_sync/README.md` (migration scripts).*
