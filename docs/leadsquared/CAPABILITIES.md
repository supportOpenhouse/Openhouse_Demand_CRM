# LeadSquared — Capability Reference

> Single source of truth for **what Claude can do on this tenant via API**, verified by live probing against the OpenHouse account (api-in21). Status legend:
> - ✅ **Confirmed** — endpoint exists and this account's key can call it (tested this session or proven at scale)
> - ⛔ **Blocked** — endpoint exists but disabled for this account (permission)
> - 🚫 **UI-only** — LSQ exposes no API for this, for anyone
> - ❓ **Likely** — documented by LSQ, exact path not yet verified here

Last verified: 2026-05-16.

---

## 1. Auth & how calls are made

### Sync API (default)
- Host: `LSQ_API_HOST` (`https://api-in21.leadsquared.com`)
- Auth: `accessKey` + `secretKey` query params (`LSQ_ACCESS_KEY`, `LSQ_SECRET_KEY` in `.env`)

### Async API (high-volume, retry-safe — added 2026-05-16)
- Host: `LSQ_ASYNC_API_HOST` (`https://asyncapi-in21.leadsquared.com`)
- Auth: same `accessKey` + `secretKey` query params **PLUS** header `x-api-key: <LSQ_ASYNC_X_API_KEY>`
- Returns a `RequestId` immediately; up to 10 auto-retries; poll the per-endpoint Status API for completion.
- Use for: bulk lead capture/update, bulk activities, bulk opportunity capture/update, call logs — anything thousands+ where peak-load protection matters.
- The Status API does **not** need accessKey/secretKey, only the `x-api-key` header.

```python
# Async call helper pattern
import urllib.request, urllib.parse, json
env = dict(l.strip().split('=',1) for l in open('.env') if '=' in l)
qs = urllib.parse.urlencode({'accessKey': env['LSQ_ACCESS_KEY'], 'secretKey': env['LSQ_SECRET_KEY']})
url = f"{env['LSQ_ASYNC_API_HOST']}/v2/LeadManagement.svc/Lead.Capture?{qs}"
req = urllib.request.Request(url, method='POST', data=json.dumps(body).encode(),
    headers={'Content-Type':'application/json', 'x-api-key': env['LSQ_ASYNC_X_API_KEY']})
```

---

## 2. Capability matrix (what you can ask for)

### Leads
| Ask | Status | How |
|---|---|---|
| Create leads (single / bulk 50 per call) | ✅ | `Lead.Create`, `Lead.CreateOrUpdate` (async available) |
| Update any lead field, bulk | ✅ proven (430 owner reassigns) | `Lead.Update` |
| Change lead owner | ✅ proven | `Lead.Update` `OwnerId` |
| Change lead stage/status | ✅ | `Lead.Update` `ProspectStage` |
| Merge duplicate leads | ✅ | `Lead.Merge` |
| Search/segment by any field | ✅ | `Leads.Get` |
| **Delete leads** | ⛔ | `"Delete is not enabled for you"` — needs LSQ admin to enable |

### Opportunities (Demand Deal 12001 / Supply Deal 12000)
| Ask | Status | How |
|---|---|---|
| Create opportunities (bulk) | ✅ proven (1,431 supply) | `OpportunityManagement.svc/Capture` |
| Update opp fields (bulk) | ✅ proven (553 demand renames) | `OpportunityManagement.svc/Update` (`ProspectOpportunityId` + `Fields`) |
| Change opp owner | ✅ | `Update` with `Owner` field |
| Delete opportunities | ✅ (use with care) | `OpportunityManagement.svc/Delete` |
| Read opps + full field metadata | ✅ | `RetrieveRecentlyModified`, `GetOpportunitiesOfLead`, `GetOpportunityTypeMetadata` |

### Activities
| Ask | Status | How |
|---|---|---|
| Post activities on leads/opps (bulk) | ✅ | `ProspectActivity.svc/Create` |
| Create new activity *types* | ✅ | `ProspectActivity.svc/CreateType` |
| Read/retrieve activities | ✅ proven | `RetrieveRecentlyModified` |
| Edit/delete an existing activity | ❓ | documented; exact path not verified — ask and I'll confirm |

### Tasks
| Ask | Status | How |
|---|---|---|
| Create tasks (appointments/to-dos, bulk) | ✅ | `Task.svc/Create` |
| Update tasks | ✅ | `Task.svc/Update` |
| Mark complete / cancel | ✅ proven | `Task.svc/MarkComplete` |
| Delete tasks | ❓ | documented; verify on request |
| Report on tasks (by owner/type/date) | ✅ proven | `Task.svc/Retrieve` |

### Schema / configuration (corrected 2026-05-16 — these ARE available)
| Ask | Status | How |
|---|---|---|
| **Create custom lead fields** | ✅ | `LeadManagement.svc/CreateLeadField` |
| **Create static lists** | ✅ | `LeadSegmentation.svc/CreateEmptyList` |
| Add/remove leads to/from a list | ❓ | documented; exact sub-path to confirm |
| **Create users** | ✅ | `UserManagement.svc/User/Create` |
| **Update users** | ✅ | `UserManagement.svc/User/Update` |
| Activate/deactivate users | ❓ | exists; exact method to confirm |
| Permission templates | ❓ | documented; verify on request |

### Comms & integration
| Ask | Status | How |
|---|---|---|
| Send email to a lead | ✅ | `EmailMarketing.svc/SendEmailToLead` |
| Create webhooks (outbound events) | ✅ | `Webhook.svc/Create` |
| Read users / sales groups / lists | ✅ | read endpoints |
| Send SMS | ❓ | not found on probed paths — likely unlicensed |

### Also documented by LSQ (verify on first use)
Sales Activity, Account (B2B company) management + account activities, Team management, Entity sharing (share/revoke lead+opp), Telephony call logs, Notifications (browser push), Async API, Batch Jobs, Lapps (server-side custom logic), Mavis custom DB, Analytics, Service CRM tickets, Portal API.

---

## 3. 🚫 UI-only — no API for anyone (don't ask me to script these)
Automations / Workflows · Smart Views / Lead Views · Landing Pages / Web Forms · Process Designer / Sales Process · Lead distribution rules · Opportunity-Type schema creation · Email/SMS template *content* (raw send works).

For these I can: read current state, tell you the exact UI click-path, and pre-stage data so the manual step is trivial.

---

## 4. Existing scripts (`_*.py`) — reuse these patterns
| Script | Does |
|---|---|
| `_bulk_opp_create.py` | bulk Capture opportunities (dedup + per-lead owner) |
| `_demand_name_fix.py` | bulk Opp `Update` with dry-run + backup + verify (template for any bulk update) |
| `_global_owner_check.py` | tenant-wide owner-mismatch audit |
| `_demand_check.py` | visits vs AVFU task cross-reference |
| `_visits_apply*.py` / `_sync_visit_attrs.py` | sheet → LSQ visit/attr sync |
| `_mark_rfi_*.py` / `_rfi_top*.py` | RFI quota cleanup + task completion |
| `snapshot.py` | refresh `snapshots/` (config dump) |

**Safety pattern (always followed for writes):** refetch fresh → dry-run preview CSV + backup JSON → 1-record live test → batch with rate-limit + retry → read-back verify → audit log. See `_demand_name_fix.py`.

---

## 5. How to give commands
Just describe the outcome. Examples that map cleanly to ✅ capabilities:
- "Add a custom field `mx_X` to leads" → `CreateLeadField`
- "Create a static list of these N leads" → `CreateEmptyList` (+ add-leads)
- "Bulk-update field Y to Z for opps where …" → `Update` (dry-run first)
- "Reassign all leads from owner A to B" → `Lead.Update` loop
- "Onboard this new user" → `User/Create`
- "Push these 5,000 lead updates without rate-limit risk" → Async API

If it's ⛔ or 🚫 I'll say so immediately and give the workaround/click-path instead.
