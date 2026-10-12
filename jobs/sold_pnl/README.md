# Sold Property P&L — hourly job

Rebuilds **"Sold Property P&L - System Generated"**
(`1f_r2z-ZorD6Yu3xvFSjLRVQHLh_10DhOWt6Q1pKj_qM`): tab **Sheet1** (active deals) and **Cancelled Deals**.
Bookings from 1 Jun 2026 onwards. Column-by-column sources are in the docstring at the top of `sold_pnl.py`.

| | |
|---|---|
| Runs on | Render cron job `oh-sold-pnl-hourly`, every hour at :05 (UTC schedule `5 * * * *`) |
| Code | this folder (`rootDir jobs/sold_pnl`), auto-deploys from `main` |
| Reads | supply Neon (Demand Dashboard bookings + units), TMD Neon, Demand CRM Neon (MM leads), inventory sheet "All Properties", AMA register |
| Writes | only the two tabs above |
| Env | `NEON_SUPPLY_URL`, `NEON_TMD_URL`, `CRM_DATABASE_URL`, `GOOGLE_SERVICE_ACCOUNT_JSON` (set on the Render service) |

Safety: every DB session is read-only. The job refuses to write if the active row count drops more than 20%
against the sheet or required fields are missing, and after writing it reads both tabs back (row count, header,
formula errors, sale-price total). Any failure exits 1, which shows as a failed run in Render.

**Failure alerts:** any failed run (missing env, precheck, postcheck, crash) WhatsApps Akshit — template `job_alert_v1`,
falling back to the approved `daily_briefing_v1` (templates deliver even when the 24h window is closed; free text is the
last resort). Env: `WHATSAPP_TOKEN`, `WHATSAPP_PHONE_NUMBER_ID`, `WHATSAPP_TO`. Test with `ALERT_TEST=1` (sends one test
message and exits **without refreshing the sheet** — never leave it set on Render).

Run locally without writing: `DRY_RUN=1 python sold_pnl.py` (writes `pnl_dry_run.json`).

Rules Akshit set that live in code: `MM_LEAD_SET_BY_AKSHIT` (Noida Extension → Ajitesh Singh, Raj Nagar Extension →
Aditya Bhasker, NH24 → Manish Pal) and `SOCIETY_ALIASES`. Change them there.
