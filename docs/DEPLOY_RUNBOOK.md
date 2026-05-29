# Deploy Runbook · OpenHouse Demand CRM

> Step-by-step for taking this branch from "code on main" to "demand team is using it."
> Backend on **Render** · Frontend on **Vercel** · DB on **Neon**.
> Owner: Saransh (support@openhouse.in). Backup: Akshit (akshit@openhouse.in).
> Total time start-to-finish: ~90 min the first time.

---

## 0. Inventory before you start

Have these tabs open:

- https://console.neon.tech (project: oh-crm)
- https://dashboard.render.com
- https://vercel.com/dashboard
- https://console.cloud.google.com → APIs & Services → Credentials
- 1Password (the service-account JSON for Sheets lives here — ask Akshit if you don't have access)

Have these in your password manager:
- Neon `DATABASE_URL` (pooler, with `?sslmode=require`)
- Google OAuth client ID + secret
- Google service account JSON (the one `_build_seed.py` uses)

---

## 1. Generate the secrets you'll need

In any terminal:

```bash
python3 -c "import secrets; print('SESSION_SECRET=' + secrets.token_urlsafe(48))"
python3 -c "import secrets; print('INTERNAL_CRON_TOKEN=' + secrets.token_urlsafe(48))"
```

Save both. They go into Render's Environment Group (next step) and only there. Never commit them.

---

## 2. Render — backend + cron

### 2a. Create the Environment Group (shared secrets)

1. Render dashboard → **Environment** (left sidebar) → **Environment Groups** → **New Environment Group**.
2. Name: `oh-crm-secrets`. Region: **Singapore**.
3. Add these vars — leave value blank if you don't have it yet (you'll come back):

| Key | Value source |
|---|---|
| `DATABASE_URL` | Neon pooler URL with `?sslmode=require` |
| `GOOGLE_OAUTH_CLIENT_ID` | from Google Cloud Console (step 4) |
| `GOOGLE_OAUTH_CLIENT_SECRET` | from Google Cloud Console (step 4) |
| `SESSION_SECRET` | the one you generated in step 1 |
| `INTERNAL_CRON_TOKEN` | the one you generated in step 1 |
| `GOOGLE_SERVICE_ACCOUNT_JSON` | paste the FULL JSON contents on ONE line (escape newlines: `tr -d '\n' < ~/service-account.json` then paste) |

### 2b. Connect the repo as a Blueprint

1. Render → **New** → **Blueprint**.
2. Connect this GitHub repo (`oh-demand-crm`). Branch: `main`.
3. Render reads `render.yaml` from the repo root. You'll see two services:
   - `oh-demand-crm-api` (Web Service)
   - `oh-demand-crm-sheet-sync` (Cron Job)
4. Click **Apply**. Both services will spin up. The Web Service takes ~3 min for the first build.

### 2c. Verify the API is up

Once the Web Service shows "Live":

```bash
curl https://oh-demand-crm-api.onrender.com/health
# expect: {"ok":true,"service":"oh-demand-crm-api"}
```

If you get 500: open the Logs tab. Most common cause is `DATABASE_URL` missing — fix the env group and re-deploy.

---

## 3. Neon — apply schema + bootstrap

You can run the bootstrap from your laptop (one-time) — no need to do it on Render.

```bash
cd /Users/saranshkhera/Documents/GitHub/oh-demand-crm/backend
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt

# Set env from the values you put in Render
cp .env.example .env
# Edit .env: fill DATABASE_URL, GOOGLE_OAUTH_CLIENT_ID/SECRET, SESSION_SECRET,
# INTERNAL_CRON_TOKEN, GOOGLE_APPLICATION_CREDENTIALS_PATH (point to local SA JSON).

# Apply schema + seed users + first sheet pull + derive owners
set -a; source .env; set +a
python3 -m api.bootstrap
```

What you should see in the log tail:
```
schema applied
upserting 24 users
sheet sync result: {"brokers": {"seen": 4681, "ins": 4681 ...}, ...}
derived <N> tier_assignments (T3/T4 fallback)
derived <N> cp_assignments
bootstrap complete
```

If it errors on the schema apply, check that the Neon role has `CREATE` permission on the database and that the `pgcrypto`, `citext`, `btree_gist`, `pg_trgm` extensions are allowed. Neon's default role has all of those.

**Spot-check the DB:**

```bash
psql "$DATABASE_URL" -c "SELECT team, COUNT(*) FROM users GROUP BY team;"
psql "$DATABASE_URL" -c "SELECT COUNT(*) FROM brokers;"
psql "$DATABASE_URL" -c "SELECT COUNT(*) FROM visits;"
psql "$DATABASE_URL" -c "SELECT COUNT(*) FROM properties;"
psql "$DATABASE_URL" -c "SELECT tier, COUNT(*) FROM tier_assignments WHERE effective_to IS NULL GROUP BY tier;"
psql "$DATABASE_URL" -c "SELECT * FROM sheet_sync_log ORDER BY run_started_at DESC LIMIT 5;"
```

Expected order of magnitude: 24 users, ~4,500 brokers (the sheet is currently 4,681), ~7,500 visits (subject to `SEED_VISITS_LIMIT`), ~280 properties, T1+T2 ≈ 250.

---

## 4. Google OAuth — create the client (~10 min)

1. https://console.cloud.google.com → APIs & Services → OAuth consent screen.
   - User type: **Internal** (uses your `openhouse.in` workspace).
   - App name: `OpenHouse Demand CRM`.
   - Support email + dev email: `support@openhouse.in`.
   - Save.
2. Credentials → **Create Credentials** → **OAuth client ID**.
   - Application type: **Web application**.
   - Name: `oh-demand-crm-prod`.
   - **Authorized JavaScript origins:**
     - `https://oh-demand-crm.vercel.app`
   - **Authorized redirect URIs:**
     - `https://oh-demand-crm-api.onrender.com/auth/google/callback`
3. Save. Copy the **Client ID** and **Client secret**.
4. Paste both into Render's `oh-crm-secrets` Environment Group (the `GOOGLE_OAUTH_CLIENT_ID` and `GOOGLE_OAUTH_CLIENT_SECRET` rows).
5. Restart the Web Service so it picks up the new env (Render does this automatically when an env group changes, but force a re-deploy if it doesn't).

---

## 5. Vercel — frontend

1. Vercel dashboard → **Add New** → **Project**.
2. Import the same `oh-demand-crm` GitHub repo.
3. **Framework Preset:** Other.
4. **Root Directory:** `frontend` ← important — point Vercel at the `frontend/` subfolder so it only ships `crm.html`, `brand/`, and the logo, never the Python backend or docs.
5. **Build & Output:**
   - Build Command: leave EMPTY (no build needed).
   - Output Directory: leave EMPTY.
   - Install Command: leave EMPTY.
6. Click **Deploy**. First deploy takes ~30s — it's a static publish.
7. Visit `https://oh-demand-crm.vercel.app/`. You should see the CRM topbar load, then a Google OAuth bounce, then the data view.

If the OAuth redirect lands on an error page:
- Verify the redirect URI in Google Cloud Console **exactly** matches `https://oh-demand-crm-api.onrender.com/auth/google/callback` (trailing slash matters).
- Verify the JS origin includes `https://oh-demand-crm.vercel.app` (no trailing slash).

---

## 6. Sanity checks before handing the URL to the demand team

Sign in as Akshit (admin). Then walk through:

- [ ] **/api/me returns the right user.** DevTools → Network → `me`. `team` should be `Admin`.
- [ ] **/api/seed returns all 4 lists.** Network → `seed`. Expect `brokers.length ≥ 4000`, `visits.length` near 1500 (the `SEED_VISITS_LIMIT`), `properties.length` near 100.
- [ ] **A KAM scope works.** Use the admin impersonation switcher → "Shubham Sharma". Visits view should narrow to his CPs.
- [ ] **Save a followup.** Open any visit → write a note → Save. Toast says "Followup saved". DevTools shows `POST /api/followups` → 200.
- [ ] **Confirm it persisted.** Run `psql ... -c "SELECT * FROM followups ORDER BY created_at DESC LIMIT 3;"` — your save should be the top row.
- [ ] **Nudge another user.** Open a KAM-owned visit as a Ground PM → Nudge → send. Confirm `POST /api/nudges` → 200. The KAM gets a notification on next page load.
- [ ] **Sheet sync runs.** Wait 15 minutes (or manually trigger): `curl -X POST -H "X-Internal-Cron-Token: $TOKEN" https://oh-demand-crm-api.onrender.com/admin/sync`. Check `sheet_sync_log` for a new row.

If any of those fail, **don't share the URL with the demand team yet** — fix and re-test.

---

## 7. Hand off to the demand team

Slack message template (paste into #demand-team):

```
Hi team — the new Demand CRM is live at https://oh-demand-crm.vercel.app/.
Sign in with your @openhouse.in Google account. If it says you're not on the
roster, ping me (support@openhouse.in) — I'll add you in a minute.

What works today:
  • Read everything (brokers, visits, properties, queue) with real synced data
  • Save followups, send nudges, mark notifications read, pin CPs to daily lists

What's coming next week:
  • Engagement form save (currently in-memory only — will vanish on reload)
  • Bulk reassign, queue → owner assignment
  • Team messages / broadcasts (in-memory only today)
  • LSQ followup history backfill (last 12 months)

Found a bug? DM Saransh + Akshit with: what you clicked, what you expected,
what happened, and a screenshot. We're triaging same-day this week.
```

---

## 8. Known limitations on day 1 (be honest about these)

| What | Status today | When |
|---|---|---|
| Bulk reassign of visits | In-memory only — won't persist | Week 2 |
| Engagement form save | In-memory only | Week 2 |
| Team messages / broadcasts | In-memory only | Week 2 |
| Add/edit team member | In-memory only | Week 2 |
| Snapshot image share (html2canvas) | Works, but image only — caption text via WhatsApp follows separately | Already noted in HANDOVER.md §10 |
| LSQ followup history | Not yet — only writes since cutover are in `followups` | LSQ dev, Phase B (~Week 2) |
| Overdue notifications cron | The frontend renders existing ones; cron that GENERATES new ones daily not wired yet | Week 2 — easy: see `_recompute_overdue_notifs` placeholder |
| Server-side scope filter on /api/seed | Off — every authed user can see everything. Write endpoints DO enforce per-row permission. | Tighten in v1.1 |

---

## 9. Roll back

If something breaks badly:

- **Frontend:** Vercel → Deployments → previous deployment → "Promote to Production". Instant.
- **Backend:** Render → Deploys → previous deploy → "Rollback". Takes ~30s.
- **DB:** Neon → Branches → restore the `main` branch to a Point-in-Time. The 30 days of PITR is free.

A roll-back never deletes user data — `followups` are append-only and the trigger projects forward only. Reverting the API just means you lose any new code paths until you redeploy.

---

## 10. Daily/weekly ops checklist

| Cadence | Check |
|---|---|
| Each morning | Render → Logs of `oh-demand-crm-api`: 0 unhandled exceptions overnight |
| Each morning | Run `SELECT * FROM sheet_sync_log WHERE status != 'success' AND run_started_at > now() - interval '24h';` — 0 rows expected |
| Weekly | Render → Metrics → response p95 < 800ms |
| Weekly | Neon → DB size — under 1 GB free tier limit |
| Monthly | Add partitions for the next month: I'll add a SQL one-liner to the runbook when we get close (Apr 2027 is currently the last pre-created partition for `followups` + `notifications`). |

---

## 11. Support escalation

- **Day-to-day, code, ops:** Saransh — support@openhouse.in
- **Roster changes, business rules, who owns what:** Akshit — akshit@openhouse.in
- **LSQ-specific issues:** the developer doing the LSQ migration (see [LSQ_HANDOVER.md](LSQ_HANDOVER.md))

Don't hesitate to ping in `#demand-crm-ops` — that's the channel for this app.
