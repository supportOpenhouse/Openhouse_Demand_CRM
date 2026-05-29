# LSQ → Demand CRM · Migration Handover

> **Audience:** the developer wiring LeadSquared into the new CRM Postgres DB.
> **Owner of this doc:** Saransh Khera (support@openhouse.in). Backup: Akshit Chaudhary (akshit@openhouse.in).
> **Status when you start:** the new CRM is live with sheet-sync only. The `followups`, `nudges`, `notifications`, and `integration_log` tables exist; only `followups` written by users via the app are currently in them. Your job is to make LSQ activity history flow into `followups` and keep it flowing.

---

## 1. The 60-second context

OpenHouse runs a 4-team demand workflow (Admin / TL / KAM / Ground) that today happens across Google Sheets + LeadSquared. The new CRM (crm.html → Vercel + FastAPI on Render + Neon Postgres) replaces it. Sheets still flow in (broker DB, visits, inventory). **LSQ is the source of truth for every follow-up activity** — that's what you're migrating.

Read these in order before writing code:
1. [`SARANSH_HANDOVER.md`](SARANSH_HANDOVER.md) §5 — the full 5-phase plan with mapping table.
2. [`BACKEND_SCHEMA.md`](BACKEND_SCHEMA.md) — full DDL; pay attention to `followups`, `nudges`, `integration_log`.
3. [`leadsquared/CLAUDE.md`](leadsquared/CLAUDE.md) + [`leadsquared/HANDOVER.md`](leadsquared/HANDOVER.md) — the LSQ side: auth pattern, snapshots, rate-limit behavior.
4. [`leadsquared/_dm_extract_lsq.py`](leadsquared/_dm_extract_lsq.py) — the working extractor you'll fork.
5. [`leadsquared/snapshots/activity_schemas.md`](leadsquared/snapshots/activity_schemas.md) — every custom field on every Demand-* activity.

---

## 2. What I'll give you (when you're ready to start)

| Item | What to ask Saransh for |
|---|---|
| **Neon Postgres connection string** | A read+write role scoped to `followups`, `nudges`, `notifications`, `integration_log`, `users`, `visits`. Use the pooler URL (`?sslmode=require`). |
| **LSQ credentials** | Host `https://api-in21.leadsquared.com`, access key, secret key. Akshit shares via 1Password. Same key the existing `leadsquared/` scripts use. |
| **Email → CRM user map** | The 24 CRM `users.slug → users.id` mapping. I'll dump it for you on day 1. The LSQ user roster (49 people) overlaps but isn't 1:1; bridge by `email`. |
| **Cutoff timestamp for backfill** | Akshit will pick. Default: pull last 12 months of activities 213-221. |

You're free to deploy your sync wherever fits — a separate Render Cron Job, Fly machine, GitHub Action, whatever. **It must NOT live in the FastAPI process** — backfill takes hours and would block the web service.

---

## 3. When to start

Phase 1 (DB up + sheet sync running) is done before you read this. The web app is live. **You can start as soon as you have credentials.** Nothing in your work blocks the demand team — they're using the app today against sheet data; your additions show up as the followups land.

Order of your work:

| Week | What |
|---|---|
| 1 | Phase A · discovery / reconciliation (use snapshot files; no writes yet). |
| 2 | Phase B · historical backfill, write into `followups` with `source='lsq_migration'`. |
| 3 | Phase C · forward sync every 15 min. |
| 4 | Phase D · cutover (write-back to LSQ during a coexistence window — coordinate with Akshit). |
| 5 | Phase E · decommission LSQ direct access. |

---

## 4. The exact write contract

Every LSQ activity in 213-221 maps to ONE `followups` row. Idempotency key is `lsq_activity_id` (UNIQUE index already on the table — second insert of the same activity is a no-op).

Minimal insert:

```sql
INSERT INTO followups (
  visit_id, by_user_id, buyer_status, stage, note,
  next_followup_date, revisit_date,
  lsq_activity_id, lsq_activity_type, source
) VALUES (
  $1, $2, $3, $4, $5,
  $6, $7,
  $8, $9, 'lsq_migration'           -- 'lsq_sync' for forward-sync rows
)
ON CONFLICT (lsq_activity_id) WHERE lsq_activity_id IS NOT NULL DO NOTHING;
```

A trigger projects the latest followup back onto `visits.current_stage` / `current_status` / `latest_followup_*` automatically — don't update those columns yourself.

### Field mapping (LSQ activity → followups columns)

| LSQ activity | code | → followups.stage | → followups.buyer_status | Notes |
|---|---|---|---|---|
| AVFU | 221 | `revisit_scheduled` if `mx_Custom_2` set, else `avfu` | `mx_Custom_3` lowercased | `next_followup_date` ← `mx_Custom_1`; `revisit_date` ← `mx_Custom_2` |
| Visit Status | 214 | derived from `mx_Custom_1` (Scheduled / Completed / Cancelled) | `mx_Custom_6` | if cancelled, set `metadata.cancelled_reason` |
| Negotiation | 215 | `negotiation` | `mx_Custom_4` | `metadata.cancelled_reason` ← `mx_Custom_2` |
| Booking Done | 216 | `booking` | `mx_Custom_9` | `metadata.token_amount`, `sale_amount`, `brokerage_pct` |
| ATS Signed | 217 | `ats` | from `mx_Custom_3` | `metadata.ats_signed_at` ← `mx_Custom_2` |
| Payment Status | 220 | (skip — store on ATS followup's metadata.payment_followup) | `mx_Custom_2` | enrich the latest ATS followup for this visit instead of inserting a new row |
| Demand Phone Call | 212 | (NOT a followup → write to `engagements` instead) | n/a | engagement note from the activity body |
| Inventory not available | 218 | `need_more` | `dead` | |
| Visit to be Scheduled | 213 | (creates a `visits` row, not a followup) | n/a | upsert `visits.visit_code` from `mx_Custom_VisitId` if your extract provides one; else dedupe by buyer + selected_date + society_name |

### Buyer status canonicalization

LSQ writes `mx_Custom_3` as `Hot`, `Warm`, `Cold`, `Dead`, or blank. Map to lowercase `hot/warm/cold/dead`. Blank → `unc`. Future Prospect comes from `mx_Custom_3 = 'Future Prospect'` → map to `future_prospect`.

### Resolving the visit

Each LSQ activity is on a Lead. Find the matching `visits` row by:
1. `lsq_visit_activity_id = <activity.Id>` (if you stored it on the row earlier),
2. Else join via `buyers.lsq_lead_id = activity.RelatedProspectId`. Pick the most recent open visit for that buyer if multiple.
3. If no `visits` row exists, log to `integration_log` with `succeeded=false`, severity warning — the daily reconciliation alert (Saransh runs) will surface it.

### Resolving the user

LSQ activity carries `ModifiedByName` or `Owner`. Match to `users.email` (case-insensitive). If no match, fall back to the "ghost" user `system@openhouse.in` (Saransh will create this for you). Log the mismatch to `integration_log`.

---

## 5. Phase A · discovery (no writes)

1. Use the existing `leadsquared/_dm_extract_lsq.py` as-is. It already pulls activities 12001/215/221 + tasks. Add 213, 214, 216, 217, 220, 218, 212. Dump to `/tmp/dm_*.json`.
2. Produce a reconciliation report. Counts to surface:
   - AVFU activities with NULL `mx_Custom_3` (pipeline status) — should be < 5%
   - Visits in the CRM (sheet-sourced) with no AVFU in the same date range — anomaly
   - LSQ users with no `users.email` match in the CRM — list emails
   - Activities older than the proposed backfill cutoff
3. Share the report in Slack with Saransh + Akshit. **Fix data-quality problems before Phase B** — the backfill will copy bad data otherwise.

---

## 6. Phase B · historical backfill

1. Pull paginated. The existing extractor handles 14-day chunks + 1000-row pages — keep that pattern; LSQ rate-limits otherwise.
2. Wrap every batch in a savepoint. If any row fails, log to `integration_log` and continue.
3. **Always `ON CONFLICT (lsq_activity_id) DO NOTHING`.** Backfill must be re-runnable.
4. Target throughput: ~500 rows/s into Neon is comfortable. The bottleneck will be LSQ pagination, not Postgres.
5. After the run: produce a spot-check sample of 100 random `followups` for Akshit to validate. Share as a CSV.

---

## 7. Phase C · forward sync

Two channels, both running:

**Primary — polling (every 15 min):**
- LSQ `GetLeadActivities` filtered by `LastActivityModifiedDate > last_sync_at` where `last_sync_at` is the latest `synced_from_lsq_at` you've stamped.
- Upsert into `followups` by `lsq_activity_id`.
- Track sync runs in `sheet_sync_log` (yes, reuse this table — set `sheet_name='lsq'`).

**Secondary — webhook:**
- LSQ allows webhooks on activity create for specific types. Configure for 213-221.
- The webhook should hit a single endpoint you own (NOT the FastAPI app — keep this isolated). On receipt, write to `integration_log` and enqueue/process. The polling job will catch anything the webhook misses.

Two channels = no data loss if either fails. Document the run in `sheet_sync_log` so we can see when each ran.

---

## 8. Phase D · cutover (coexistence window)

| Step | Day | What |
|---|---|---|
| Read-only CRM | Day 1 | Users browse CRM with LSQ-sourced data. No CRM writes. |
| Dual write | Day 2-7 | CRM `POST /api/followups` ALSO pushes to LSQ via API. LSQ remains official record. |
| CRM primary | Day 8-14 | CRM is sole user-facing UI. Background job pushes to LSQ within 30s. |
| CRM only | Day 15+ | LSQ push-back disabled (or kept for archival). |

Conflict rule during dual-write: **last-write-wins by timestamp.** Conflicts logged to `integration_log` with severity=warning.

I'll add the LSQ push-back webhook on the FastAPI side when you reach Phase D — it'll fire after a successful `POST /api/followups`.

---

## 9. The 7 edge cases you must handle

| Case | Handling |
|---|---|
| LSQ activity references an unknown `RelatedProspectId` | Insert into `integration_log` (succeeded=false), skip the row. |
| CRM save → LSQ push fails | Backoff retry up to 24h via your worker queue; finally page #demand-crm-ops. CRM data is never lost. |
| Same LSQ activity arrives twice | `ON CONFLICT (lsq_activity_id) DO NOTHING` — automatic. |
| LSQ user doesn't map to CRM user | Use the `system@openhouse.in` ghost. Daily report lists unmapped emails. |
| AVFU `pipeline_status` empty | `buyer_status = 'unc'`. Don't make up a status. |
| Buyer phone differs LSQ vs visitors sheet | LSQ wins (operational). Diff logged. |
| LSQ rate-limits during backfill | Chunk into 1000-row batches with exponential backoff. Backfill takes hours — it's one-time. |

---

## 10. What I expect to see in your PR

- `lsq_sync/` directory at the repo root (mirror of `api/`).
- A clear `lsq_sync/README.md` with: how to run locally, how it deploys, what env vars it needs.
- Idempotent backfill script.
- Forward-sync worker.
- Unit tests for the activity-type mapping (the hardest place to get wrong).
- A status dashboard or `SELECT * FROM sheet_sync_log WHERE sheet_name='lsq' ORDER BY run_started_at DESC LIMIT 20;` page Saransh + Akshit can hit.

---

## 11. Support

| Topic | Who |
|---|---|
| DB schema questions, FastAPI write contract, the role matrix | Saransh — support@openhouse.in |
| LSQ business rules, when to cutover, owner of an ambiguous activity | Akshit — akshit@openhouse.in |
| LSQ API quirks (rate-limit weirdness, 500s on Users.Get, etc.) | See [`leadsquared/CAPABILITIES.md`](leadsquared/CAPABILITIES.md) — Akshit maintains this |

When in doubt: open a thread in `#demand-crm-ops` (or whichever Slack channel Saransh sets up), tag both Saransh and Akshit. Don't merge to main without a green review from at least one of us.
