# LeadSquared Workspace — Handover

A new chat session should be productive within 5 minutes by reading this file. CLAUDE.md is the short index; this is the operational deep dive.

**Last updated:** 2026-05-15

---

## 1. Quick start (read this first)

**Workspace:** `/Users/akshit.chaudhary/Documents/Claude Code/leadsquared/`

**Credentials:** `.env` (gitignored)
```
LSQ_ACCESS_KEY=u$r…
LSQ_SECRET_KEY=…
LSQ_API_HOST=https://api-in21.leadsquared.com
```
- **Region:** India (api-in21)
- **API key user:** Prashant Singh (Administrator). All writes show `ModifiedBy = Prashant Singh`.
- **Rate limit:** **20 calls per 5 seconds** (4/sec hard cap). At 0.27s sleep we get ~1.5–2/s real throughput due to network latency. Plan time accordingly.
- **NEVER echo or commit credentials.** They're already in chat history once; we shouldn't add more occurrences.

**Refresh the snapshot:**
```bash
cd "/Users/akshit.chaudhary/Documents/Claude Code/leadsquared" && python3 snapshot.py
```
Idempotent. Re-run after major LSQ config changes.

**Run any of the _*.py scripts:** all use `python3 -u` and the `.env` credentials. Most are designed to be run in the background with the Monitor tool for progress pings.

---

## 2. Folder layout

```
leadsquared/
├── .env                                    # credentials
├── .gitignore                              # excludes .env, *.log, __pycache__
├── CLAUDE.md                               # short index (this file = HANDOVER.md is the longer one)
├── HANDOVER.md                             # ← you are here
├── snapshot.py                             # builds snapshots/ from API
├── apps_script/
│   ├── demand_dashboard.gs                 # archived Google Apps Script (creds redacted)
│   └── supply_dashboard.gs
├── flow/                                   # placeholder for synthesized business-flow doc
├── snapshots/
│   ├── SUMMARY.md                          # top-level snapshot index
│   ├── lead_fields.md / activity_types.md / activity_schemas.md / users.md / sales_groups.md / lead_lists.md / webhooks.md
│   ├── raw/                                # full JSON payloads for grep/jq
│   │   ├── activity_schemas.json
│   │   ├── activity_types.json
│   │   ├── lead_fields.json
│   │   ├── lead_lists.json
│   │   ├── sales_groups.json
│   │   ├── task_types.json
│   │   ├── users.json
│   │   └── webhooks.json
│   └── (operational outputs — see "Operational history" below)
└── _*.py                                   # one-off scripts (see "Scripts reference")
```

---

## 3. The LeadSquared model on this tenant (essential business context)

**Two-sided real-estate funnel:**

| Side | Lead = | Opportunity (event code) | Custom activity codes |
|---|---|---|---|
| **Supply** | Seller | Supply Deal (`12000`) | 200 (Phone Call), 201 (Lead Qual), 202 (Home Visit), 203 (Offer Qual), 204 (Seller Meeting), 205 (Negotiation & Token), 209 (Schedule Seller Meeting) |
| **Demand** | Buyer (visits stored against the seller's lead) | Demand Deal (`12001`) | 206 (Phone-CP), 207 (Meeting-CP), 208 (Reg Interaction Call -CP), 210 (WhatsApp), 211 (Share Lead), 212-217 (Demand-prefixed), 219 (Converse Chat), 221 (Demand- After Visit Follow Up) |

**Subtle but critical:** on this tenant a **Demand Deal opp lives on the seller's lead** (the seller is the "lead", the buyer's name is `mx_Custom_4` on the Demand Deal opp). One seller lead can have many Demand Deal opps (one per buyer who visited that property).

**Two ownership fields, easy to confuse:**
- `OwnerId` on the **lead** → who owns the seller record
- `Owner` field on the **opportunity** → who owns the deal

Moving an opportunity in the LSQ UI changes only the opp's `Owner`. The parent lead's `OwnerId` does NOT auto-follow. **This caused all the Apr 30 / May 7 cleanup work** (see Operational history).

**Supply users:** Arti Ahirwar, Ashish Bibyan, Nisha Deewan, Prashant Singh, Rupali Prasad, Sushmita Roy, Kavita Rawat, Prakhar Vaish, Apurv Nath
**Demand users:** the rest of the active sales team — Shubham Sharma, Saket Kumar, Mukul Chhabra, Adiksha Sahu, Ajitesh Singh, Puran Kiraula, Ashwani Sharma, Vinay Kumar, Ankit Kumar, Abhash Kumar, Umer Khan, Aman Rawat, Joginder Singh, Vipul Suneja, Mayank Chauhan, Sahil Kumar, Ankit Gupta, Jyoti Singh, etc.

**Quotas for daily Friday RFI tasks:** 80 per person, 120 for **Saket / Mukul / Shubham**.

---

## 4. Connections, endpoints, and patterns

### 4.1 LSQ API endpoints we use

| Action | Endpoint | Method | Notes |
|---|---|---|---|
| Get lead by ID | `/v2/LeadManagement.svc/Leads.GetById?id=<lead_id>` | GET | Returns full lead w/ all custom fields |
| Search leads | `/v2/LeadManagement.svc/Leads.Get` | POST | Body has `Parameter.LookupName` + `LookupValue`. Use `mx_CP_code` to find a CP by code, `OwnerId` to list a user's leads, etc. |
| Update lead | `/v2/LeadManagement.svc/Lead.Update?leadId=<lead_id>` | POST | Body is array of `[{Attribute, Value}]`. Use for owner change, attribute updates. |
| Bulk update leads | `/v2/LeadManagement.svc/Lead/Bulk/UpdateV2` | POST | Max **25 leads per call**. `SearchByKey` MUST be a unique field. **`mx_CP_code` is NOT unique on this tenant** — use `ProspectID` instead. |
| Get opps for a lead | `/v2/OpportunityManagement.svc/GetOpportunitiesOfLead?leadId=<id>&opportunityType=<event>` | POST (body `{}` ok) | Returns each opp with own `Owner` + `P_OwnerIdName` (parent lead owner) |
| Create opp | `/v2/OpportunityManagement.svc/Capture` | POST | Body has `LeadDetails[]` (with `SearchBy` + value) + `Opportunity.{OpportunityEventCode, Fields[]}` |
| Update opp | `/v2/OpportunityManagement.svc/Update` | POST | Required: `ProspectOpportunityId` + `RelatedProspectId` + `OpportunityEvent` + `Fields[]` |
| Activities (read) | `/v2/ProspectActivity.svc/RetrieveRecentlyModified` | POST | Body filters by `FromDate`/`ToDate`/`ActivityEvent` |
| Activity custom-update | `/v2/ProspectActivity.svc/CustomActivity/Update` | POST | Only works for true custom activities (event 2xx). Silently no-ops on opportunity events (12000/12001) |
| Tasks (read) | `/v2/Task.svc/Retrieve` | POST | Body filters by `OwnerEmailAddress` + `StatusCode` (0=Open, 1=Completed) |
| Task update (description, etc.) | `/v2/Task.svc/Update` | POST | Body: `{UserTaskId, Description, …}`. Does NOT mark complete. |
| Mark task complete | `/v2/Task.svc/MarkComplete?id=<task_id>` | GET | Sets StatusCode=1, CompletedOn=now |
| Users list | `/v2/UserManagement.svc/Users.Get` | GET | Already in `snapshots/raw/users.json` |
| Sales groups | `/v2/UserGroup.svc/Retrieve` | GET | |

### 4.2 Boilerplate Python call helper

```python
def call(path, body=None, method='POST', retries=2):
    qs = urllib.parse.urlencode({'accessKey': env['LSQ_ACCESS_KEY'], 'secretKey': env['LSQ_SECRET_KEY']})
    url = f"{env['LSQ_API_HOST']}{path}?{qs}"
    for a in range(retries+1):
        try:
            req = urllib.request.Request(url, method=method,
                data=(json.dumps(body).encode() if body else None),
                headers={'Content-Type': 'application/json'})
            with urllib.request.urlopen(req, timeout=60) as r:
                return json.loads(r.read()), None
        except urllib.error.HTTPError as e:
            if e.code == 429 and a < retries: time.sleep(2 ** a); continue
            return None, f"HTTP {e.code}: {e.read().decode()[:200]}"
        except Exception as e:
            return None, f"{type(e).__name__}: {e}"
    return None, "exhausted"
```

Always include `time.sleep(0.27)` between calls to stay under the rate limit.

### 4.3 What the API DOES NOT expose (UI-only)

These were probed exhaustively (see `snapshot.py` and `_global_owner_check.py` — all the 404s):

- **Automations / Workflow rules** — must be exported manually from LSQ admin UI
- **Landing Pages / Web Forms** — `LandingPage.svc/Retrieve` returns empty `{}` even with valid Type — likely 0 configured
- **Smart Views / Lead Views** — no API
- **Opportunity Type list-all** — must read codes from Settings → Opportunities → Opportunity Types, then use `/v2/OpportunityManagement.svc/GetOpportunityTypeMetadata?code=<code>`
- **Lead Distribution Rules** — no API
- **Permission templates / role definitions** — no API
- **Email/SMS templates** — partial; not wired in

For automation logic you need to know about, ask the user to screenshot the rule from LSQ admin and drop into `snapshots/manual/` for transcription.

### 4.4 mx_Custom field map (Demand Deal, event 12001)

From the demand-dashboard Apps Script (`apps_script/demand_dashboard.gs`):

| Field | Meaning |
|---|---|
| `mx_Custom_1` | Deal title (typically `<FirstName>- Opportunity- <Society>- <Locality>`) |
| `mx_Custom_2` | Stage (`New Deal`, `Visited`, `Visit to be Scheduled`, `Negotiation & Token`, `Booking Done`, `Rejected by Openhouse`, etc.) |
| `mx_Custom_3` | Lead source |
| `mx_Custom_4` | Buyer name |
| `mx_Custom_5` | Broker info (often `Broker: <name> | Broker Ph: <phone> | CP Code: <code>`) |
| `mx_Custom_8` | Revisit date |
| `mx_Custom_11`, `mx_Custom_37` | Sales owner (text — may be stale; trust LSQ Owner field instead) |
| `mx_Custom_13` | Buyer phone |
| `mx_Custom_15` | City |
| `mx_Custom_28`, `mx_Custom_39` | Visit date |
| `mx_Custom_36` | **Sales Feedback / Note (200-char limit on this tenant!)** |
| `mx_Custom_38` | Broker type |
| `mx_Custom_40` | Floor |
| `mx_Custom_41` | Facing |
| `mx_Custom_42` | Unit address (often `<Floor> <Unit#> <Society>`) |

### 4.5 mx_* fields on the CP (lead, when stage is CP-related)

| Field | Meaning |
|---|---|
| `mx_CP_code` | Unique-ish CP code (e.g., `CP04374`). NOT configured as a unique LSQ field. |
| `mx_d30_visits`, `mx_d60_visits`, `mx_d90_visits`, `mx_all_time_visits` | Visit counts. **These were stale in LSQ until 2026-05-15** — synced from `Broker_data_query` Sheet1. Consider re-syncing if dashboard data changes. |
| `mx_Lead_Status` | Buyer pipeline temperature: `Hot`/`Warm`/`Cold`/`Dead` (or `Onboarded` / etc. for CPs) |
| `mx_Active_Micromarket_for_CP`, `mx_Locality_for_CP`, `mx_City_latest` | Geo |
| `mx_Designation_Role`, `mx_Onboarded_By` | CP attributes |

---

## 5. Scripts reference (`_*.py`)

All scripts in the project root. Each is self-contained and reads `.env` directly. Most write outputs to `snapshots/`.

| Script | What it does | Last used |
|---|---|---|
| `snapshot.py` | Pulls users, lead fields, activity types/schemas, sales groups, task types, lead lists, webhooks → `snapshots/`. Re-run anytime. | 2026-04-30 |
| `_bulk_opp_create.py` | Bulk-creates Supply Deal opps via `Capture` for "New Lead" leads that have no opp. Resumable via checkpoint. | 2026-04-30 |
| `_demand_check.py` | Demand-side scan: builds visit list (event 12001) + matches against tasks/activities for follow-up coverage. | 2026-04-30 |
| `_demand_name_fix.py` | Fixes demand-opp deal-title mismatches. | 2026-05-08 |
| `_global_owner_check.py` | Tenant-wide owner-mismatch scan: enumerates opps, compares opp.Owner to lead.OwnerId via name→UUID map. | 2026-05-07 |
| `_visits_dryrun*.py` (v1, csv, v2, v3) | Sheet → LSQ matching for visit-intent form data. v3 is the latest with strict-HIGH confidence scoring. | 2026-05-08 |
| `_visits_apply*.py` (v1, v2) | Applies the visit-intent updates to LSQ — appends form details to opp note (200-char cap → falls back to compact format). | 2026-05-08 |
| `_mark_rfi_complete.py` | Marks given RFI tasks complete via `MarkComplete`. Resumable: writes done IDs to `rfi_markcomplete_done.txt`. | 2026-05-14 |
| `_rfi_top70_*.py`, `_rfi_top80_v3.py` | Per-owner ranking of CPs by priority (P1: d90>0; P2: created last 60d; P3: all_time>0; P4: rest), apply quota cutoff (80/120). | 2026-05-15 |
| `_mark_rfi_top80_drop.py` | Marks complete the RFI tasks outside the per-owner quota. Resumable. | 2026-05-15 |
| `_sync_visit_attrs.py` | Syncs `mx_d30/d60/d90/all_time_visits` from `Broker_data_query` CSV → LSQ via Bulk/UpdateV2. | 2026-05-15 |

---

## 6. Operational history (what we've done, in order)

### 2026-04-30 — Initial discovery + ownership cleanup

- Built `snapshot.py` and pulled all snapshottable LSQ data
- **Discovered the supply→opp ownership-divergence pattern**: someone bulk-moved opps to Nisha but lefts leads behind on original owners
  - **Rupali → Nisha:** transferred 430 lead owners to Nisha (so opp.Owner == lead.OwnerId)
  - Backup: `snapshots/owner_change_backup_2026-04-30.json`
- **Inverse pass (other direction):** Arti / Sushmita / Prashant → Nisha: 643 lead owners aligned
  - Files: `snapshots/owner_change_backup_inverse_2026-04-30.json`, `…_results_inverse_2026-04-30.json`
- **Created 1,435 missing Supply Deal opps** for "New Lead" sellers (had leads but no opp)
  - Used `Capture` API. Backup: `snapshots/opp_creation_results_2026-04-30.json`
- **Jyoti owner-gap:** found 282 opps assigned to Jyoti but parent lead owned by someone else → transferred lead owners to Jyoti
  - Files: `snapshots/owner_change_backup_jyoti_2026-04-30.json`, `…_results_jyoti_2026-04-30.json`

### 2026-05-07 — Tenant-wide owner-mismatch audit

- Ran `_global_owner_check.py` across 8,046 leads with opp activity in last 365 days
- Found **180 mismatches** (1.5%) — small enough to leave for manual review (probably intentional manager-holds-lead arrangements)
- File: `snapshots/global_owner_mismatches.csv`
- 4 supply users now confirmed as **Demand owners gone manager**: Adiksha Sahu, Saket Kumar, Mukul Chhabra hold leads while reps own opps

### 2026-05-08 — Demand-side checks + visit-intent form sync

- **Demand visit follow-up coverage check:** found **1,046 unique visits** in 60 days; only 212 (20%) had AVFU activity (event 221) — the metric only started recording ~Apr 12, 2026, so older visits show "missing" but really were tracked differently
  - 80%+ gap rate concentrated in 5 sales reps: Abhash, Ajitesh, Vinay, Puran, Deepanshu
  - File: `snapshots/demand_visits_no_avfu_activity.csv`
- **Sushmita Noida count:** 93 Greater Noida CPs assigned to her despite Greater Noida being routed to Arti per current rules — historical mis-assignments
- **Visit-intent form sync (Visitors form responses sheet → LSQ):**
  - 296 sheet rows, 271 matched with HIGH confidence (society + unit + buyer + date all align)
  - **219 visit notes appended** (compact format due to 200-char cap on `mx_Custom_36`)
  - 36 lead `mx_Lead_Status` values updated (only when blank or unmodified-since-creation)
  - All went via `OpportunityManagement.svc/Update` on the Demand Deal opp record
  - Files: `snapshots/visits_dryrun_strict_high.csv`, `snapshots/visits_apply_v2_results.json`

### 2026-05-14 — Cold CP transfers + Friday-engagement task cleanup

- **140 Gurgaon cold CPs → Shubham, 58 Noida → Saket** (per "Team Cold CPs.xlsx")
  - Files: `snapshots/owner_change_backup_cp_2026-05-14.json`, `…_results_cp_2026-05-14.json`
  - 198/198 success; 3 not found in LSQ: CP01945 (Deepak), CP02171 (Yogesh), CP02055 (Narender)
- **Discovered RFI overdue backlog:** 92,307 task-rows scanned across users → **8,091 unique tasks** (per-user fetches double-count)
- **Marked all 8,091 unique RFI tasks complete** over ~15-hour overnight run
  - Files: `snapshots/rfi_markcomplete_done.txt`, `…_fail.jsonl`

### 2026-05-15 — Top-80/120 quota cleanup + visit-attrs sync

- **Per-owner top-80/120 RFI quota** (Saket / Mukul / Shubham = 120, others = 80)
  - 3,876 RFI tasks created today (Friday), distributed across 19 owners
  - Priority: P1 d90>0 → P2 created last 60d → P3 all_time>0 → P4 rest
  - **Kept 1,396**, **marked 2,391 complete**, 89 safety-held (no `mx_CP_code` on lead)
  - Files: `snapshots/rfi_top80_plan.csv`, `…_drop_tasks.json`, `…_done.txt`, `…_safety_held.json`
- **Synced `mx_d30/d60/d90/all_time_visits` from `Broker_data_query - Sheet1 (9).csv` to LSQ**
  - 4,363 unique CPs in CSV → 4,321 matched in LSQ → all updated via `Lead/Bulk/UpdateV2`
  - 42 not found (typo in cp_code or lead deleted)
  - File: `snapshots/sync_visits_results.json`
  - Cache: `/tmp/cp_code_to_pid.json` (kept for re-runs)

---

## 7. Known issues, open follow-ups, and gotchas

### 7.1 Known LSQ tenant quirks

1. **`mx_Custom_36` (Sales Feedback / Note) is capped at 200 chars** on this tenant. Visit-intent sync uses a verbose format if it fits, falls back to compact (`T:15-20m | Tour:Full | …`), skips if even compact won't fit. To raise the cap: LSQ admin → My Profile → Settings → Customization → Custom Activities → Demand Deal → edit `mx_Custom_36` → Maximum Length → save.
2. **`mx_CP_code` is NOT a unique field** in LSQ. Bulk update via `SearchByKey=mx_CP_code` fails. Use `ProspectID` after a per-CP lookup.
3. **`CustomActivity/Update` silently no-ops on opportunity events** (12000/12001). For those, use `OpportunityManagement.svc/Update` instead.
4. **Per-user `Task.svc/Retrieve` returns duplicates** (~11x) because LSQ returns tasks RELATED to each user, not just owned by. Always dedupe by `UserTaskId` after a system-wide scan.
5. **Friday RFI auto-creator sets DueDate 1 minute after CreatedOn** → tasks become "overdue" almost immediately. The team's overdue dashboard always looks alarming. The backlog grows unless tasks are actively closed.
6. **Activity event 221 (Demand- After Visit Follow Up) only started recording ~Apr 12, 2026.** Older visits show "missing AVFU" but they probably weren't tracked this way at all. Anchor any time-windowed analysis to Apr 12+ for fair comparison.
7. **Vishal Singh lead** (`4f7912a3-f0a5-11f0-a635-0630e4b64663`) has `LeadType: Object type` (a non-standard custom Object Type). Cannot create Demand Deal or Supply Deal opp on this lead via API — needs admin to re-classify in LSQ UI.

### 7.2 Patterns / safety rules to follow

- **Always backup before bulk owner changes:** dump the lead_id + previous owner UUID to `snapshots/owner_change_backup_<context>_<date>.json` before running.
- **Always test on 1 row before bulk:** especially for new endpoint shapes. Half of today's bugs were caught this way.
- **Resumable scripts:** every long-running job writes done IDs to `snapshots/<task>_done.txt` (one ID per line, append-only). On restart, the script reads this file into a set and skips done IDs. Don't break this pattern.
- **89 safety-held RFI tasks:** these have no `mx_CP_code` on the parent lead — likely test/misconfigured leads. Don't auto-close. See `snapshots/rfi_top80_safety_held.json`.
- **Owner mismatch as proxy for "Adiksha-style manager arrangement":** if an opp.Owner ≠ lead.Owner and both are real users, it's often an intentional manager-holds-lead arrangement (Saket, Mukul, Adiksha do this). Don't bulk-fix without checking.

### 7.3 Open follow-ups (NOT done — for future sessions)

1. **Prevention automation** — set up an LSQ Automation rule "Opportunity Owner Changed → set Lead Owner = Opportunity Owner". This would prevent the 1,000+ orphaned-lead pattern that drove April 30's cleanup. **Requires LSQ admin UI access** (Prashant / Ashish / Rahool / Manish). Spec is in chat but not yet configured.
2. **Daily scheduled sync for visit attributes** — the `Broker_data_query - Sheet1` CSV is presumably refreshed nightly. `_sync_visit_attrs.py` could run on cron to keep LSQ aligned. Not yet wired up.
3. **Daily owner-mismatch drift check** — run `_global_owner_check.py` daily; alert if mismatches grow back. Not yet wired up.
4. **3 missing Cold CP codes** — `CP01945` (Deepak), `CP02171` (Yogesh), `CP02055` (Narender). Likely typos in the original Cold CPs sheet. Worth verifying with the team.
5. **Vishal Singh lead** — needs admin to fix the object-type mismatch before any opp can be created on it.
6. **89 safety-held RFI tasks** — manual review needed.
7. **Automation export** — when admin gets a chance, export each LSQ Automation as a screenshot + transcription into `snapshots/manual/automations/`. Until then, Claude can't reason about what auto-fires when.
8. **Demand Admin permission grant for Puran + Ajitesh** — UI-only. Needs an Administrator (Prashant, Ashish, Rahool, Manish). Default Admin role is tenant-wide; a granular "Demand Admin" template doesn't exist yet on this tenant — would need to be created.
9. **Friday RFI auto-creator duplicate bug** — May 8 had up to 308 duplicate tasks for one CP (Sachin). Today's run (May 15) was cleaner (3,876 unique, no major duplication observed). Worth monitoring weekly.

---

## 8. Cross-references — Apps Script + Drive sheets

### 8.1 Live Google Apps Scripts (in OpenHouse's GAS project)

Mirrored locally with creds redacted in `apps_script/`:

- **`demand_dashboard.gs`** — Demand-side dashboard. Pulls users, CPs, visits (event 12001), tasks, activities. Builds 6 dashboard tabs in Google Sheets: CP Owner Scorecard, Last 60d Visits, Daily Dashboard, Hot/Warm Leads 60d, Society Detail 60d, Unit Detail 60d. Field map for Demand Deal opp is at the top of this file.
- **`supply_dashboard.gs`** — Supply-side daily report. Filters to 7 sellers (REPORT_USERS), excludes CP stages, builds per-rep tabs + Daily Dashboard.

These are reference docs for the field semantics and stage taxonomy. The runtime versions live in the user's GAS project — our local copies have placeholders for credentials.

### 8.2 Google Sheets we read from

| Sheet | File ID | Purpose |
|---|---|---|
| Visitors form responses (visit-intent form) | (CSV downloaded to ~/Downloads) | Source for `_visits_apply_v2.py`. Drive MCP read returns truncated content; user provides clean CSV. |
| Broker_data_query | `1bUkpfbceA7lLpMhRh2aoB-oGCwnzUiyD4sIclm25Z1k` | Sheet1 has up-to-date d30/d60/d90/all_time_visits per CP. **LSQ values for these were stale until 2026-05-15 sync.** |
| Team Cold CPs | (xlsx in ~/Downloads, `Team Cold CPs.xlsx`) | Source for the May 14 Gurgaon→Shubham + Noida→Saket transfers. |

---

## 9. How to handle common new requests

(Future-Claude playbook based on patterns we've seen)

| User says | Likely path |
|---|---|
| "X moved an opp/lead to Y, but seller is still with X" | Lead vs opp ownership split. Run `Lead.Update` for the affected leads (after backup + dryrun). Reference: April 30 work. |
| "How many leads with no opp?" | Use `_bulk_opp_create.py` logic (universe of supply leads minus those with 12000 activity). Read-only first. |
| "Sync sheet → LSQ for X attribute" | If attribute is on lead: `Lead.Update` per-lead, or `Lead/Bulk/UpdateV2` if you can use ProspectID as search key. Reference: `_sync_visit_attrs.py`. |
| "Mark a bunch of tasks complete" | `_mark_rfi_complete.py` pattern. GET `MarkComplete?id=<task_id>`. ~1.7/sec. Resumable via done-list file. |
| "Find all opps where Owner=X" | No direct search-by-owner endpoint exists. Use the activity-universe approach: get unique RelatedProspectIds from `12000`/`12001` activities → for each, `GetOpportunitiesOfLead` → filter Owner. |
| "Update visit notes / opp custom field" | If field is `mx_Custom_36`, watch the 200-char limit. Use `OpportunityManagement.svc/Update`, not `CustomActivity/Update` (which no-ops for opp events). |
| "Per-owner top N CPs by priority" | Reference: `_rfi_top80_v3.py`. Read CSV for d90/all_time, fetch CP-to-PID via LSQ, rank by priority, apply quota. |
| "List all automations / forms / smart views" | NOT possible via API. Tell user: needs UI export. |

---

## 10. Auto-memory pointers

These are saved in `~/.claude/projects/-Users-akshit-chaudhary-Documents-Claude-Code/memory/`:

- `reference_leadsquared.md` — short pointer to this workspace
- `reference_openhouse_backend.md` — Django backend at `/Users/akshit.chaudhary/code/openhouse/core`
- `reference_atlassian_jira.md` — Jira/Atlassian workspace
- `project_openhouse_broker_app.md` — Broker app redesign project (separate from this LSQ work)

When a future session starts, those memory entries point back here.

---

**End of HANDOVER.md.** Update this file whenever a meaningful operation completes — append to "Operational history" with date + counts + file paths. Keep "Open follow-ups" current as items get done or new ones surface.
