# OpenHouse Demand CRM — Handover

> **Audience:** the next Claude session continuing this build. Read this end-to-end before touching the code. It supersedes everything else.
> **State at handover:** all 8+ rounds of UI work landed. Production prototype on Netlify; data is in-browser only (no DB yet).
> **Live URL:** https://oh-demand-crm.netlify.app
> **Owner:** akshit@openhouse.in

---

## 1. Folder layout

```
<repo-root>/
├── crm.html                  # the entire app (CSS + HTML + JS in one file)
├── seed.json                 # data pulled from sheets (brokers, visits, properties)
├── _build_seed.py            # script to refresh seed.json from the 4 source sheets
├── _fetch_sheets.py          # earlier exploratory script — dumps every tab to /sheet_snapshots/
├── _fetch_team_retry.py      # retry the team sheet tabs that hit Google quota
├── sheet_snapshots/          # one folder per source sheet with .schema.md + .head.csv per tab
│   ├── visitors/             # 42 cols, 7,691 rows of visit data
│   ├── brokers/              # 4,681 brokers across many tabs
│   ├── live_inventory/       # 101 active + 282 all-time properties
│   └── team/                 # 28 tabs of strategy/plan/tiering
├── brand/
│   └── logo-icon.svg         # OpenHouse mark, brand colours #FA541C + #161C24
├── FINDINGS.md               # research notes from sheet study + LSQ flow (read before changing data model)
├── SIMILAR_PROPERTIES_LOGIC_v2.md  # the supply-side similar-properties algorithm (used as inspiration for CP property suggestions)
├── deploy/                   # what gets pushed to Netlify
│   ├── index.html            # copy of crm.html
│   ├── seed.json
│   ├── brand/
│   └── netlify.toml
├── leadsquared/              # the previous LSQ tooling (read-only reference)
│   └── snapshots/            # field metadata, activity schemas, users — see HANDOVER.md inside
└── HANDOVER.md               # THIS FILE
```

**Important:** `crm.html` is a single self-contained file (~270 KB). All edits go there. `deploy/index.html` is a copy used only for Netlify upload.

---

## 2. Source data — where every field comes from

### Sheets (read via the global service account)

| Sheet (Drive) | Key tabs we use | What we extract |
|---|---|---|
| `Visitors data` (`17eEX021…`) | `Sheet1` | All 42 visit columns including 6 buyer-intent columns (`time_spent_on_site`, `society_amenity_tour`, `price_discussion`, `client_queries`, `closing_signal`, `buyer_primary_concern`) + `lead_status` (hot/warm/cold/dead/future_prospect/select_status) + `all_feedback` chronological notes |
| `Broker_data_query` (`1bUkpfb…`) | `Sheet1` (4,681 brokers), `LeadSquare` (CP owner emails), `stage` (Demand Team Owner) | All broker fields: cp_code, name, phone, company, city, micro_markets, societies_worked, d30/60/90/all_time_visits, activity_category, added_by |
| `Openhouse Live inventory` (`1-kxlCnX…`) | `Sheet1` (101 active), `All Properties` (282 incl. archived) | property_name, society_name, city_name, micro_market, locality_or_sector, listing_status (Ready / Coming Soon), configuration, super_sqft, carpet_sqft, exit_facing, balcony_view, listing_price, commission, **sales_manager (= PM)**, photo_count, video_added |
| `Demand Planning sheet` (`18XoHGV…`) | `18 Broker Tiers` (250 ranked names), `05 Team Structure`, `28 Team Plan v2`, `26 Tier 1+2 CP Engagement Plan`, `14 Onboarder People` | Tier 1+2 broker list with rank/has_sold/bookings, team plan v2 (KAM × 5 + Adiksha TL + Ground × 14), engagement cadence |

### Refreshing the seed

```bash
cd <repo-root>
python3 _build_seed.py     # writes seed.json (~826 KB)
# Then to redeploy:
cp crm.html deploy/index.html && cp seed.json deploy/seed.json
cd deploy
# Use the Netlify MCP `deploy-site` (siteId 375ff0ea-91ea-404f-a744-0164d985845c)
# OR with CLI:
netlify deploy --prod --site=375ff0ea-91ea-404f-a744-0164d985845c
```

### LeadSquared mapping (the source of truth for the demand workflow)

- The AVFU (`After Visit Follow Up`) activity carries the buyer thermal: `mx_Custom_3` = Hot / Warm / Cold / Dead. **This is what "Buyer Status" in the CRM represents.**
- Operational stages map 1:1 to LSQ activity types: AVFU 221, Visit to be Scheduled 213, Visit Status 214, Negotiation 215, Booking Done 216, ATS Signed 217.
- See `leadsquared/snapshots/activity_schemas.md` for every field on every Demand-* activity.

---

## 3. Team roster — who's in what team

Defined in `crm.html` in the `USERS` array. **Each person belongs to exactly one team.**

| Team | Users | Their job |
|---|---|---|
| **Admin** | Akshit Chaudhary, Ankit Khemka | Sees everything; only role that can change CP tier and CP owner; manages the To Be Assigned queue + Team & Assignments |
| **TL** (Team Lead / Heads / Closers) | Manish Pal, Rajnish, Puran Kiraula (Gurgaon closer), Ajitesh Singh (Noida closer) | City-wide visibility; bulk reassign; can pin CPs to anyone's daily list; can broadcast messages |
| **KAM** (Key Account Manager — calling team) | Adiksha Sahu (TL), Shubham Sharma, Aman Rawat, Mukul Chhabra, Mayank Chauhan, Saket Kumar | Each owns 25 Tier 1 + 25 Tier 2 brokers in their city. Drive visits per Tier 1+2 broker from 3.5 → 6/mo |
| **Ground** (Field / Property Managers) | Abhash Kumar, Sahil Kumar, Vinay Kumar, Joginder Singh, Aditya Bhasker, Ankit Kumar, Vipul Suneja, Ashwani Sharma, Hashim, Harsh Arora, Ankit Gupta, Udit Gangwar | Own Tier 3 + Tier 4 brokers (the inactive bucket). Each PM is also assigned to specific properties via `live_inventory.sales_manager`. They onboard new CPs and activate dormants. |

**CP ownership rules** (`store.cpOwner` map):
- Tier 1 + Tier 2 → KAMs, round-robin by city
- Tier 3 + Tier 4 → Ground team members, prefer the original `added_by` if they're Ground, else round-robin

---

## 4. State shape — what lives in JavaScript

### `store` (data, mostly read-only in this prototype)

```js
store = {
  brokers: [],              // array of broker objects (391 in seed)
  brokersByCode: {},        // cp_code → broker
  visits: [],               // 400 recent visits
  properties: [],           // 101 live properties
  toAssignCps: new Set(),   // CP codes awaiting owner assignment (30 in seed)
  cpOwner: {},              // cp_code → user.id
  pmByProperty: {},         // property_name → user.id (PM)
  followupLog: [],          // every in-session followup save
  engagements: {},          // cp_code → array of engagement records
  nudgesByVisit: {},        // visit_id → array of nudge records (with from/to/message/resolved)
  notifications: [],        // user notifications inbox (in-memory)
  teamTasks: {},            // user.id → { daily_calls: [cp_codes], messages: [{from,text,ts,priority}] }
  notifSeq: 1,              // monotonic id counter
}
```

### `state` (current UI selection)

```js
state = {
  currentUserId,            // who is logged in (impersonation switcher)
  view,                     // 'visits' | 'cps' | 'properties' | 'queue' | 'team' | 'notifications' | 'snapshot'
  cityFilter,               // 'all' | 'Gurgaon' | 'Noida' | 'Ghaziabad'
  search,                   // free-text
  statusFilter,             // 'all' | hot/warm/cold/dead/future_prospect/unc
  stageFilter,              // 'all' | stage key
  lastFuFilter,             // 'all' | 'overdue' | 'not_taken' | 'today' | 'yesterday' | 'last3' | 'last7' | '2w' | '3w' | 'older'  — **defaults to 'not_taken'** so the view auto-prunes
  cpLastFuFilter,           // same enum for CP view
  priorityFilter,           // 'all' | 'nudged' | 'tl_ask'
  cpPriorityFilter,         // same for CP view
  filters,                  // detail filter modal output
  page, pageSize, sortField, sortDir,
  selectMode,
  selectedVisits, selectedCps, selectedQueue,   // Sets
  cpSort, propFilter, tierTab,                  // tab state
  isMobile,                 // computed from viewport ≤900px
  expandedVisits,           // visit ids currently open in popup
  popupTab,                 // 'visits' | 'engagement' | 'timeline'
  popupStage,               // stage tab inside the broker popup ('all' default)
  collapsedTiers,           // CP-view tier collapse state
  openBrokerCp, focusVisitId, openProperty,     // popup state
  propStageTab,             // active stage tab inside property popup
  bulkContext,              // 'selected' | 'rule' | 'queue' | 'cps' | 'pin_to_day'
  followupDrafts,           // visit_id → { status, stage, note, next_date, revisit_date }
  engagementDraft,          // active engagement form data
  nudges,                   // Set of visit ids nudged this session (UX feedback)
  nudgeVisitId,             // current nudge composer target
  teamSelectedId,           // selected team member in Team view
  pinCpCode,                // current "Pin to day" cp
  waCp, waScreen, waTplId, waSnapshotCities,    // WhatsApp picker state
  snapImg, ...
}
```

---

## 5. Roles & permissions matrix

| Capability | Admin | TL | KAM | Ground |
|---|:-:|:-:|:-:|:-:|
| See all visits / CPs / properties | ✓ | city only | own CPs | own CPs + visits at their properties |
| Change CP tier | ✓ | — | — | — |
| Change CP owner | ✓ | — | — | — |
| Bulk reassign visits | ✓ | ✓ | — | — |
| Set daily call list for any user | ✓ | ✓ | own only | own only |
| Pin a CP to someone's day | ✓ | ✓ | — | — |
| Send messages / broadcast | ✓ | ✓ | — | — |
| Add / edit team member | ✓ | — | — | — |
| Nudge any CP not owned by self | ✓ | ✓ | ✓ | ✓ |
| Edit followups | ✓ | ✓ | own CPs | own CPs + at their properties |
| Save engagement | ✓ | ✓ | own CPs | own CPs |

Logic implementations are in `visitsForUser()`, `brokersForUser()`, `propertiesForUser()`, `isAdmin()`, `canEditTier()`, `canEditOwner()`, and per-button checks in the renderers.

---

## 6. Pipeline stages — the canonical set

```
upcoming               (visit booked, not yet happened)
avfu                   (After Visit Follow Up — buyer just visited)
revisit_scheduled      (a revisit is on the calendar — has v._revisit_date)
after_revisit_fu       (auto-shifts here when revisit_date passes)
negotiation            (price/deal in motion)
booking                (token taken)
ats                    (agreement signed)
future_prospect        (parked, revisit later)
not_interested         (dead — explicit)
need_more              (dead — wants other properties)
cancelled              (visit was cancelled)
all                    (pseudo-stage for "All Leads" tab in broker popup)
```

`visitStage(v)` resolves a visit's effective stage. It checks `v._stage` (local override), then auto-transitions `revisit_scheduled` → `after_revisit_fu` when `v._revisit_date < today`. Backward-compat: any old `'revisit'` key is mapped to `revisit_scheduled`.

`visitStatus(v)` returns the buyer-thermal (`hot/warm/cold/dead/future_prospect/unc`). **"unc" stands for "Not Updated"** — the label was renamed from "Unclassified" to match internal vocabulary; WhatsApp templates suppress this string before sending to brokers.

---


## 7. Every feature — what it is, where it lives

### Visit view (`#view-visits`)
- 4 chip rows (top → bottom): **Buyer Status** / **Visit Stage** / **Last Followup Taken** (default: "Not taken yet" with overdue chip first) / **Priority** (Nudged / TL Ask). Renderers: `renderStatusChips`, `renderStageChips`, `renderLastFuChips`, `renderPriorityChips`.
- Table columns: ★ / ID / Visit / City / RM / Society+Unit / Buyer / CP+Tier / CP Owner+role / Src / Status / Stage / Next FU / Last FU / Priority tag / Price. Sortable.
- Each row → opens broker popup with that visit as focus.
- Mobile: same data as cards via `renderVisitBodyMobile`.

### CP view (`#view-cps`)
- 2 chip rows: **Last Followup Taken** + **Priority**. Renderers: `renderCpLastFuChips`, `renderCpPriorityChips`.
- Tier tabs (T1 / T2 / T3 / T4) — `state.tierTab`.
- Table columns: Rank / Channel Partner / City·MM / CP Code / Activity / D30 / D60 / D90 / All time / Onboarded by / CP Owner / Last visit / **Last FU taken** / Priority tag. Sort within tier via `state.cpSort`.

### Broker popup (`#modal-broker`)
- **Header**: avatar, name + tier badge + rank, phone, alt, company, city pill, CP Owner, Onboarded by. Stats: D30 / D90 / All time / Bookings / Has Sold.
- **Action buttons**: 📌 Pin to day (admin/TL only) · 📞 Call (tel:) · 💬 WhatsApp (opens picker) · ✕ Close.
- **Banner area**: any active nudges on this CP's visits + any TL messages to viewer + a "On TL daily call list" badge if applicable. Tap nudge → jumps to the visit.
- **Main area tabs**: Visits / Engagement / Timeline.
  - **Visits** tab: stage tabs (All first, then Upcoming / AVFU / Revisit Scheduled / After Revisit FU / Negotiation / Booking / ATS / Future Prospect / Not Interested / Need More / Cancelled). Each visit row collapses by default; clicking opens followup form.
  - **Engagement** tab: form with 5 structured questions (`inventoryShared`, `recordingDone`, `listingDone` + link, `listingFollowupDate`, `supportAsked` + `supportDetails`, `remarks`) + mandatory `notes` textarea. Past engagements listed below. Save persists into `store.engagements[cp_code]`.
  - **Timeline** tab: chronological feed of EVERYTHING about this CP — visit bookings, completions, cancellations, all_feedback entries, in-session followups, nudges sent/resolved, engagement entries, onboarding event.
- **Side panel (lp-side)**: Tier, CP Code, Onboarded date, Phone/Alt, Activity, Has sold, Sales attrib, Bookings, **Preferred Markets** (chips), **Preferred Societies** (chips), 6-month **Visit trend** mini-chart, Demand Mix KPIs, **Suggested matching inventory** (uses cp.micro_markets ∩ ready inventory). Admin-only: tier dropdown + CP owner dropdown.
- Mobile: 4-way toggle (Visits / Engagement / Timeline / Info).

### Followup form (inside expanded visit row)
- 2 chip groups: **Buyer Status** (hot/warm/cold/dead/future_prospect) + **Next Stage** (avfu/revisit_scheduled/after_revisit_fu/negotiation/booking/ats/future_prospect/not_interested/need_more).
- When `Revisit Scheduled` is picked, a **Revisit date & time** datetime-local input appears (mandatory).
- **Notes textarea is mandatory** — save is blocked with a toast + textarea border-flash if empty.
- "Next FU" date input + Save buttons.
- Save triggers `saveFollowup(visitId, action)`. This also auto-resolves any pending nudges on the visit and notifies the nudgers (`resolveNudgesForVisit`).

### Nudge composer (`#modal-nudge`)
- Context line ("Nudging X about Y's visit to Z…"). Notes textarea + quick-pick chips with common phrases.
- **Universal**: anyone can nudge any CP whose owner is not themselves. The owner can be KAM, Ground, TL — doesn't matter.
- On send, `addNudge(visitId, message)` pushes nudge record and notifies the owner. Resolution notification fires when the owner saves a followup on that visit.

### WhatsApp picker (`#modal-wa`)
- 5 templates:
  1. Open WhatsApp blank
  2. 7-day visit summary (suppresses "unc" status string)
  3. Open buyers pipeline (suppresses "unc" — uses "🕓 Pending status")
  4. Live inventory · {CP's city}
  5. Live inventory · Noida + Ghaziabad (only for Noida/Ghaziabad CPs)
- Editable preview before send → opens `wa.me/{phone}?text={encoded}` in new tab.

### Inventory Snapshot view (`#view-snapshot`)
- Header summary + 8 share buttons (4 image + 4 text per city/combo).
- Sections by city with orange gradient header + locality clusters. Table with colgroup-controlled widths so columns align.
- **Image flow** uses `html2canvas` (loaded from CDN). Builds an offscreen poster (`.poster` styles), captures to canvas, opens preview modal (`#modal-snap-img`). Buttons: Copy image to clipboard / Download PNG / Open WhatsApp (downloads then opens text-only wa.me — user attaches the PNG manually).
- **Text flow** opens `openInventorySnapshotShare(cities)` — same modal-wa with a clustered text message.

### Property popup (`#modal-property`)
- Same wide-popup pattern. 5 stat tiles. Stage tabs over visits at this property. Each visit shows: buyer + CP+tier + **CP Owner with role pill** + status + stage + next-FU chip + nudge button (if CP isn't yours).
- Right panel: property details + Top CPs bringing buyers (sorted by visits, with tier badge + owner role) + **Timeline** (visits, feedbacks, followups for ALL visits at this property).
- PMs can edit followups for any visit at their property (banner: "editing on behalf of X").

### Team & Assignments view (`#view-team`)
- Left sidebar: members grouped by team with daily-list count badge.
- Right panel: selected member's daily call list (admin/TL can add/remove), messages from TL/admin, recent notifications.
- **Add team member** modal (`#modal-member`) — admin only.

### To Be Assigned queue (`#view-queue`)
- 30 unassigned brokers (`added_by` is not a known PM). Bulk-select → bulk modal lets admin/TL pick KAM/Ground member + tier + note.

### Notifications view (`#view-notifications`)
- Lists every notification for current user. Click → jumps to ref (visit/CP/team page). Mark all read button. Bell icon shows unread count in topbar (desktop + mobile).

### Today banner (top of every list view)
- Reactive to: pending nudges, daily call list items, messages, unread notification count. Click jumps to relevant view.

---

## 8. Mobile mode (≤ 900 px)

Activated by `state.isMobile` + `body.mobile` class. Resize listener auto re-renders on viewport change.

| Element | Mobile change |
|---|---|
| Sidebar | Hidden; replaced by **bottom tab bar** (`#bottomTabBar`) — role-aware tabs |
| Top bar | Compact: logo + label + 🔍 search button (expands inline) + ⚙️ filters + 🔔 bell + avatar |
| Tables (Visit/CP/Property/Queue) | JS-rendered card lists (`m-card-list`) — never table cells |
| Broker popup | Full-screen. Sticky toggle: Visits / Engagement / Timeline / Info (4-way) |
| Property popup | Full-screen. Side panel stacks under main |
| Stage tabs, tier tabs, chip rows | Horizontal scrollable |
| Filters modal | Slides up from bottom (90vh max) |
| Bulk / WhatsApp / Nudge / Member modals | All bottom-sheet style |
| Selection bar | Floats just above the tab bar |

---

## 9. Quick reference — every modal id

| Modal | id | When opened |
|---|---|---|
| Broker popup (the big one) | `modal-broker` | clicking any visit row or CP row |
| Property popup | `modal-property` | clicking a property card |
| Filters | `modal-filters` | Filters button on topbar |
| Bulk reassign / Pin to day | `modal-bulk` | Select rows + bulk button, OR Pin to day button in broker popup |
| WhatsApp picker | `modal-wa` | 💬 button on any visit/CP/broker popup, OR snapshot text-share buttons |
| Nudge composer | `modal-nudge` | Nudge button on a visit row |
| Add/edit team member | `modal-member` | Admin's "+ Add team member" in Team view |
| Snapshot image preview | `modal-snap-img` | Image share buttons in Inventory Snapshot |

All modals support: `data-close=<id>` button, click-outside-to-close, Escape to close. Global handlers in `setupGlobal()`.

---

## 10. Known shortcuts & phase-3 hooks

- **Everything is in-memory.** Refreshing the page resets all in-session followups, engagements, nudges, notifications, team-task changes. The user will provide a Neon connection string for phase 3.
- **Visit-intent fields** (time on site, etc.) only show when populated in the source sheet — 139/400 visits in the current seed.
- **Property "NEW" badge** uses `listing_status==='Coming Soon'` as a proxy until `live_inventory` carries a real `addedDate` column.
- **html2canvas** is loaded from CDN. If a deploy needs to work offline, vendor it locally.
- **wa.me does not allow image attachments.** The Snapshot Image flow downloads the PNG and prompts the user to attach it manually after opening WhatsApp.
- **Overdue-followup notifications** are seeded once on init (`seedDemoActivity`). In production this should be a server-side cron pushing into the notification table daily.

---

## 11. How to make common changes

| You want to… | Where to edit |
|---|---|
| Add a new stage | `STAGES` array (top of script). Update `visitStage()` derivation if it auto-transitions |
| Change "Buyer Status" labels | `STATUSES` array |
| Add a new WhatsApp template | Push to `WA_TEMPLATES` array. Each item: `{ id, ic, t, s, build(broker), test(broker) }` |
| Add a new role | `USERS` array + extend permission helpers (`isAdmin`, `canEditTier`, `canEditOwner`, `renderNav` items, `renderBottomTabBar` per-role tab set) |
| Add a new column to the visit table | `VISIT_COLS` array + extend `sortVisits` + extend the `<td>` cells in `renderVisitBody` (desktop) and `renderVisitBodyMobile` (mobile card). Bump `table.t` min-width if needed |
| Change a popup tab | `renderBrokerPopup` builds the tab bar around `state.popupTab`. The mobile toggle is built separately just above |
| Add a notification trigger | `notify(toId, type, refType, refId, text, fromId, action)` — push a new object into `store.notifications` |
| Re-pull live data | `python3 _build_seed.py` (writes `seed.json`). Add new columns in the script if the visitors / brokers / inventory sheet schema changes |

---

## 12. Validation checklist (3-stage, per role)

### Stage 1 — sanity (does the UI render and respond?)
For each role (Admin / TL / KAM / Ground): visit every view (`visits`, `cps`, `properties`, `queue`, `snapshot`, `team`, `notifications`). Click into each broker popup tab (Visits / Engagement / Timeline / Info on mobile). Open every modal and close via X / backdrop / Escape. **No console errors.**

### Stage 2 — data correctness
For each chip row: counts must equal `list.filter(predicate).length`. Sorting must be deterministic. Filters must compose (status + stage + last_fu + priority + city + search). Searchable selects must return matching results. Save followup must:
- Block on empty notes
- Block on revisit_scheduled without date
- Update `lead_status`, `_stage`, `latest_followup_date`, `latest_followup_note`, append to `all_feedback`
- Push into `store.followupLog`
- Resolve any pending nudges
- Drop the visit out of "Not taken yet" filter
- Trigger nudge-resolved notification to the nudger

### Stage 3 — end-to-end flows
- **KAM day**: open as Shubham → Today banner shows X calls/Y messages/Z unread → click "View nudges" → land on nudged visit → save followup with notes → confirm visit drops out + nudge resolved + nudger gets notified
- **Ground day**: open as Sahil → My Properties shows their 12 properties → open one → nudge any KAM-owned visit → switch to that KAM → confirm notification
- **Admin day**: queue → bulk-assign 3 brokers → snapshot → image share for Noida+Ghaziabad → confirm PNG renders
- **TL day**: open broker popup → "Pin to day" → pick KAM → switch to KAM → confirm CP appears in their daily list + notification

### Mobile (375 + 414)
Repeat all three stages. Pay extra attention to: chip-row horizontal scroll, popup full-screen height, bottom tab role labels, sheet-style modals, snapshot image generation works (slower on mobile).

---

## 13. Recently-completed work (chronological)

1. Initial visit + CP + property views with mock data
2. Real seed pulled from sheets (FINDINGS.md captures schema)
3. Rename teams Calling→KAM, PM→Ground
4. Searchable filter dropdowns
5. Admin-only tier/owner edits
6. Stage tabs in broker popup; tier tabs in CP view; property list view
7. Property popup with nudge + timeline + on-behalf-of edits
8. Removed CP Engagement tab (folded into Channel Partners)
9. Bulk assign covers KAM + Ground; selection bar fixed
10. Mobile mode (bottom tab bar, card lists, full-screen popups)
11. WhatsApp drafted-message picker
12. Universal CP timeline tab + buyer history (cross-property)
13. Team & Assignments page with daily list + messages + add member
14. Nudge composer with resolution notification
15. Notifications view + bell icon
16. Today banner
17. Visit-intent block (the 6 buyer-signal columns)
18. Date-range picker for visit_date
19. Last followup taken filter (defaults to "Not taken yet") + column
20. Priority chips (Nudged / TL Ask) on both views
21. Inventory Snapshot view with text-share
22. **This round**: Engagement tab, mandatory notes, banner inside broker popup, split Revisit into 2 stages, Overdue chip + overdue notifications, universal nudge, snapshot-as-image (html2canvas), seamless pin-to-day, this handover doc

---

## 14. Pending / good ideas for next session

- **Persistence**: wire to Neon. All `store.*` writes (followupLog, engagements, nudges, notifications, teamTasks, cpOwner, brokers[].tier) need a backend.
- **Auth**: replace the user impersonation switcher with real Google SSO. Map google email → USERS.id.
- **Real overdue cron**: server-side job that pushes notifications when nextFu lapses.
- **Image snapshot polish**: replace the html2canvas approach with a server-side render for crisper output, OR build the poster as SVG + serialise (avoids the CDN dep).
- **Auto-refresh seed**: a button + endpoint to re-pull from sheets on demand.
- **Buyer profile page**: the buyer cross-property history is currently inline in expanded visit. A dedicated view (`/buyer/<lead_key>`) would let RMs send buyer-history links.
- **Bulk-engagement**: log an engagement against many CPs at once (e.g. "broadcast message recorded").
- **Per-property RM nudges**: when a property has no upcoming visits in N days, alert the PM.

---

## 15. Credentials and infra

- Google service account: set `$GOOGLE_APPLICATION_CREDENTIALS` to the JSON path (read-only Sheets + Drive scopes are sufficient). Akshit shares the JSON via 1Password — never commit it.
- Netlify: project `oh-demand-crm`, site id `375ff0ea-91ea-404f-a744-0164d985845c`, team `akshit-wt3wtsq` (Analytics). Dashboard: https://app.netlify.com/projects/oh-demand-crm
- OpenHouse brand assets in Drive folder shared with `shad@openhouse.in` (file ids: `1_EzERMKuQrbjCiLNeDFrIaLNRuxt5iA4` for icon SVG; `1RMrf5PWmNNHA6eq01UX4bW0Vpeo7n9lg` for complete logo).

---

End of handover. If anything is unclear, grep `crm.html` — every feature name in this doc maps to a JS function with the same name.
