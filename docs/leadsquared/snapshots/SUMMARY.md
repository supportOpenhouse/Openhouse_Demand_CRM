# LeadSquared Snapshot

Host: `https://api-in21.leadsquared.com`
Generated: 2026-04-30 11:05:25 IST

## Captured

- [Lead fields](lead_fields.md) — 142
- [Activity types](activity_types.md) — 61
- [Activity schemas](activity_schemas.md) — 23
- [Users](users.md) — 49
- [Sales groups](sales_groups.md) — 2
- [Task types](task_types.md) — 25
- [Lead lists](lead_lists.md) — 52
- [Webhooks](webhooks.md) — 2

## Known UI-only items
These have no public list-all API and require manual capture from the LeadSquared UI:

- **Automations** (Workflow designer) — export each automation diagram as PNG/PDF;
  the trigger + steps + conditions need to be transcribed to markdown
- **Landing Pages and Web Forms** — export HTML / form definition from UI
- **Smart Views / Lead Views** — screenshot the column + filter config
- **Process Designer / Sales Process flows** — diagram export
- **Opportunity Types** — no list endpoint (have to read codes from
  Settings → Opportunities → Opportunity Types, then use
  /v2/OpportunityManagement.svc/GetOpportunityTypeMetadata?code=<code>)
- **Permission templates / roles**
- **Email/SMS templates** (partial API exists)
- **Lead distribution rules**