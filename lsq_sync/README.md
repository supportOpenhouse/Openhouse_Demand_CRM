# lsq_sync — one-shot LeadSquared → Demand CRM migration

One-time migration of the LSQ demand pipeline into the CRM Neon DB, plus the
LSQ write-back that flags migrated leads. **Not** an ongoing sync — new visits
flow from the Google sheets after this.

## Files
- `migrate.py` — pulls LSQ opportunities (event 12001 = visits) + activities
  (221/215/216/217/218/220), enriches matched CRM visits with the live LSQ
  stage/status, inserts the few unmatched, loads activity history into
  `followups`, and stamps `lsq_*` ids on users/brokers/buyers.
- `writeback.py` — stamps `mx_Migrated_To_CRM` (Date) on every migrated lead
  (buyers + CPs) in LSQ. Requires that field to exist in LSQ admin first.
- `backups/` — reversibility snapshots (gitignored).

## Env
Reads LSQ creds from `$LSQ_ENV_PATH` (default `~/.../Credentials/.env`:
`LSQ_API_HOST`, `LSQ_ACCESS_KEY`, `LSQ_SECRET_KEY`) and the Neon `DATABASE_URL`
from `$CRM_ENV_PATH`.

## Run
```bash
python3 migrate.py                 # dry-run: prints projected changes, NO writes
python3 migrate.py --execute       # apply (one transaction; snapshot backup first)
python3 migrate.py --fix-owners    # repair followup by_user_id in place
python3 migrate.py --rollback backups/backup_<ts>.json   # full undo

python3 writeback.py               # dry-run: resolves target leads, checks field exists
python3 writeback.py --execute     # stamp mx_Migrated_To_CRM on every migrated lead
python3 writeback.py --rollback backups/writeback_<ts>.json   # clear the field
```

## Matching & mapping
- Visit match key: `cp_code` + `visit_date` (+ buyer first-name to disambiguate).
- LSQ Stage (`mx_Custom_2`) → CRM stage; Pipeline Status (`mx_Custom_24`) → buyer_status (blank → `unc`).
- Owners resolved from the deal RM (`mx_Custom_37`); ex-RMs become inactive users; unmapped → `system@openhouse.in`.
- Idempotent throughout (dedup on `lsq_visit_activity_id` / `lsq_activity_id`).

## Status (2026-05-29)
DB migration executed + validated (3 rounds). Write-back is **pending the
`mx_Migrated_To_CRM` field being created in LSQ admin**.
