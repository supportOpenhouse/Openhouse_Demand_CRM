# LeadSquared Workspace

> **For a new chat session: read `HANDOVER.md` first.** It contains the full operational history, every API pattern, every script, every known issue, and the playbook for common requests. This file is the short index — HANDOVER.md is the deep dive.
>
> **For the LSQ Demand Dashboard (Netlify site, refresh pipeline, automation): read `DASHBOARD_HANDOVER.md` first.** It has the full data pipeline, deploy procedure, security model, and automation plan.
>
> **For "what can you do / can you change X" questions: read `CAPABILITIES.md`.** It is the verified API capability matrix (✅ confirmed / ⛔ blocked / 🚫 UI-only), the sync + Async API auth patterns, and the command→endpoint mapping. Do not re-probe endpoints that are already classified there.

Local snapshot + tooling for the OpenHouse LeadSquared instance.

- **Region:** India (api-in21)
- **Credentials:** `.env` (gitignored — never commit, never echo)
- **Snapshot script:** `snapshot.py` — re-run any time to refresh `snapshots/`
- **Outputs:**
  - `snapshots/SUMMARY.md` — index of everything captured
  - `snapshots/<section>.md` — human-readable tables for browsing
  - `snapshots/raw/<section>.json` — full API payloads (use for grep/jq)

## How to use this folder when the user reports an issue

1. **Read `snapshots/SUMMARY.md` first** to see what data is available.
2. **Map the symptom to a section:**
   - "field X isn't saving" / "wrong dropdown options" → `lead_fields.md`
   - "activity Y missing from mobile" / "wrong custom field on activity" → `activity_types.md` + `activity_schemas.md`
   - "user can't see lead" / "wrong owner" → `users.md` + `sales_groups.md`
   - "task type X" / "appointment vs to-do" → `task_types.md`
   - "lead not in list" / "list count wrong" → `lead_lists.md`
   - "data not flowing to external system" → `webhooks.md` (currently only 2 internal LSQ webhooks; outbound integrations are likely on the OpenHouse Django side)
3. **For deeper detail, grep the raw JSON** in `snapshots/raw/`. Example: `jq '.[] | select(.SchemaName == "mx_LeadStage") | .Options' raw/lead_fields.json`.
4. **For live queries** (current state of a specific lead, recent activity, etc.), use the API directly — see "Live API queries" below.

## What's NOT in the snapshot (UI-only)

The LeadSquared public API does not expose these. To make Claude useful for issues touching them, the user needs to manually export from the UI and drop into `snapshots/manual/`:

- **Automations** (Settings → Automation): export each automation as a screenshot of the canvas + a markdown transcript of the trigger/conditions/actions
- **Landing Pages / Web Forms** (Marketing → Landing Pages): "View Source" → save HTML to `snapshots/manual/forms/<form-name>.html`
- **Smart Views** (Leads → Manage Views): screenshot the column + filter config
- **Process Designer / Sales Process** flows
- **Opportunity Types** — list manually from Settings → Opportunities → Opportunity Types; per-type metadata can then be pulled via the API
- **Lead distribution rules**
- **Permission templates / role definitions**
- **Email/SMS templates** (partial API exists but not wired into snapshot)

## Live API queries

Credentials are in `.env`. Quick one-liner for any GET endpoint:

```bash
cd "/Users/akshit.chaudhary/Documents/Claude Code/leadsquared"
python3 -c "
import urllib.parse, urllib.request, json
env = dict(l.strip().split('=',1) for l in open('.env') if '=' in l)
qs = urllib.parse.urlencode({'accessKey': env['LSQ_ACCESS_KEY'], 'secretKey': env['LSQ_SECRET_KEY']})
r = urllib.request.urlopen(f\"{env['LSQ_API_HOST']}<PATH>?{qs}\")
print(json.dumps(json.loads(r.read()), indent=2))
"
```

Common live-query paths:
- `/v2/LeadManagement.svc/Leads.GetById?id=<leadId>` — full lead record
- `/v2/ProspectActivity.svc/Activity/RetrieveByLeadId?leadId=<id>` — activities on a lead
- `/v2/Task.svc/RetrieveTasks?leadId=<id>` — tasks
- `/v2/OpportunityManagement.svc/GetOpportunitiesOfLead?leadId=<id>&opportunityType=<code>`

## Refreshing the snapshot

```bash
cd "/Users/akshit.chaudhary/Documents/Claude Code/leadsquared" && python3 snapshot.py
```

Idempotent. Re-run after any major LeadSquared config change (new custom field, new activity type, new automation, etc.). The script logs failures per-section and continues.

## Known config (from current snapshot)

- 142 lead fields, 49 users, 2 sales groups, 25 task types, 52 lead lists
- 23 custom activity types — split into supply-side ("Phone Call", "Lead Qualification", "Home Visit", "Offer Qualification", "Seller Meeting Details", "Negotiation & Token"), Channel Partner ("-CP" suffix), and demand-side ("Demand-" prefix)
- 2 webhooks — both internal LSQ mobile-nudge endpoints (Task Reminder, Task Create). **No outbound webhooks to OpenHouse backend** — if data is syncing to/from the Django backend, it's via Django pulling/pushing, not LSQ webhooks.
