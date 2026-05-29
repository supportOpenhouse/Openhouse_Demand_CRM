# Dashboard automation — setup (one-time, manual)

Goal: visits hourly, full LSQ + property-ageing daily, **without** hourly Netlify redeploys.
Mechanism: GitHub Actions builds the bundle → uploads to a Google Drive file → the Netlify
`data.mjs` downloads that file at request time (15-min cache). Netlify redeploys only for
code changes (≤1/day, via build hook).

## Steps

1. **New private GitHub repo.** Push the whole `leadsquared/` project (the `_dm_*.py`
   scripts, `dashboard_template.html`, `_dm_build_authsite.py`, `dm_site/`, and this
   `automation/` folder). `.gitignore` here already excludes `.env`, `*_sa.json`, `/tmp`.
   > pipeline.py runs the `_dm_*.py` from `automation/` (HERE). Easiest: copy/symlink the
   > root `_dm_extract_sheets.py _dm_engine.py _dm_dashdata.py _dm_enrich.py
   > _dm_build_authsite.py dashboard_template.html` into `automation/` before pushing
   > (the 3 `_dm_extract_*` helpers already live here). Or set `HERE`/cwd to repo root.

2. **GitHub → Settings → Secrets and variables → Actions**, add:
   - `LSQ_ACCESS_KEY`, `LSQ_SECRET_KEY`, `LSQ_API_HOST`  (from `.env`)
   - `GS_SA_JSON` = full contents of the service-account JSON
     (`…/Property level report/credentials/service_account.json`)
   - `DRIVE_BUNDLE_FILE_ID`, `DRIVE_CACHES_FILE_ID` (from step 3)
   - *(optional)* `NETLIFY_BUILD_HOOK` (step 5) for daily code redeploy

3. **Create the two Drive files** (run locally once, SA has Drive scope):
   ```
   cd automation && GS_SA_JSON="$(cat '…/service_account.json')" python3 pipeline.py --init-drive
   ```
   Copy the printed `DRIVE_BUNDLE_FILE_ID` / `DRIVE_CACHES_FILE_ID` into GitHub secrets.
   Seed them once: `python3 pipeline.py --mode daily` (locally) to populate both files.

4. **Point Netlify at the Drive file.** In Netlify → Site config → Env vars add
   `DRIVE_BUNDLE_FILE_ID` = same id. Replace `dm_site/netlify/functions/data.mjs` with
   `automation/data.drive.mjs` (keeps `_sa.json` bundled) and do ONE manual deploy via the
   MCP-proxy procedure in `DASHBOARD_HANDOVER.md` §4. After this, data self-refreshes.

5. *(optional)* Netlify → Build & deploy → **Build hooks** → create one → put URL in
   `NETLIFY_BUILD_HOOK` secret. The daily workflow will hit it (≤1 redeploy/day) so code
   changes ship; data never triggers a build (bundle is not committed).

## Cadence
- `refresh-hourly.yml` cron `0 * * * *` → `pipeline.py --mode hourly` (~3–4 min, light).
- `refresh-daily.yml` cron `30 21 * * *` (≈03:00 IST) → `--mode daily` (full, ~45–60 min).
- `concurrency: refresh` prevents overlap; both have `workflow_dispatch` for manual runs.

## Status
Scaffolded & documented; **not yet run end-to-end in CI** (needs the repo + secrets +
Drive files above). All logic reuses the proven `_dm_*.py` scripts unchanged.
