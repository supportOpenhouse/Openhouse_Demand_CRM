# Demand CRM — Findings (May 28)

Compiled after reading the 4 sheets, the LSQ snapshot, and the team plan.

## 1. Tiers (sheet `18 Broker Tiers` + `26 Tier 1+2 CP Engagement Plan`)

- **Tier 1 / Gold** — 125 brokers (50 GG + 50 N + 25 GZ). Criteria: ≥3 completed visits/month in Mar+Apr+May 2026 (consistent) OR has sold OR top-recent visits.
- **Tier 2 / Silver** — 125 brokers (50 GG + 50 N + 25 GZ). Lower volume, promotable to T1.
- **Tier 3** — ~400 active but inconsistent. Ground Team follows up.
- **Tier 4 / Inactive** — ~4,000 dormant.

The 250 Tier 1+2 names are frozen in the `18 Broker Tiers` tab with explicit `Rank in City`, `CP Code`, `Has Sold`, `Bookings Apr-May`, `Onboarded By`, `Onboarded On`.

## 2. Three teams (sheet `28 Team Plan v2 (Detailed)` and `05 Team Structure`)

**Team 1 — Calling Team (HQ Engagement)** — 5 callers + TL Adiksha
- Gurgaon: Aman Rawat + Shubham Sharma (joint, 100 brokers = 50 T1 + 50 T2)
- Noida: Mayank Chauhan + Mukul Chhabra (joint, 100 brokers)
- Ghaziabad: Saket Kumar (solo, 50 brokers)
- Owns G1 = visits/T1-or-T2 broker 3.5 → 6/mo. AVFU within 24h.

**Team 2 — Ground Team / Property Managers** — 14 people, owned by Rajnish (Field Head)
- Per-property assignment lives in `live_inventory.Sheet1.sales_manager`
- Top PMs by property count: Abhash Kumar 14, Ajitesh Singh 13, Sahil Kumar 12, Vinay Kumar 9, Aman Rawat 7, Shubham Sharma 7, Puran Kiraula 6, Aditya Bhasker 5, Joginder Singh 5, Ankit Kumar 5, Vipul Suneja 4, Ashwani Sharma 4, Hashim 3, Mayank Chauhan 3, Ankit Gupta 2, Harsh Arora 2.
- Several people appear in BOTH Team 1 and Team 2 (e.g. Aman, Shubham, Mukul, Mayank, Saket).

**Team 3 — Team Leads / Closers** — 4 closers + 2 division heads
- Manish Pal (Demand Head), Rajnish (Field/Onboarding Head)
- Puran (Gurgaon closer), Ajitesh (Noida closer), 2 Ghaziabad closers TBD
- Adiksha (Calling TL)
- TLs see everything for their city.

**Admin** — Akshit, Ankit (CFO), Founder.

## 3. Pipeline (LSQ AVFU activity 221 — `snapshots/raw/activity_schemas.json`)

Two orthogonal fields on every after-visit followup:

**Operational status** (where the visit goes next):
- Follow Up
- Revisit
- Negotiation Meeting
- Booking Done
- Need to Visit More Properties (lost)
- Not Interested (lost)
- Future Prospect (parked)

**Pipeline status / buyer thermal** (Hot/Warm/Cold/Dead):
- Hot, Warm, Cold, Dead — captured as `mx_Custom_3` on AVFU.

Both are required when an RM closes a followup. The visitors sheet column `lead_status` mirrors this — current distribution: dead 2138, cold 1480, select_status 3393 (unset), warm 502, future_prospect 91, hot 87.

## 4. Visitors sheet (id `17eEX021t97pGnJasMJ6v7ERE0jezKEC0S8teKepJRWQ`, Sheet1)

7,691 visit rows, 42 columns. Key fields used by the CRM:

| Column | Purpose |
|---|---|
| `id`, `selected_date`, `selected_time`, `visit_date` | When |
| `status` | upcoming / completed / cancelled |
| `lead_status` | hot / warm / cold / dead / future_prospect / select_status |
| `sales_manager` | RM handling the visit |
| `source` | channel_partner / direct |
| `broker_name`, `broker_contact`, `broker_alt_contact`, `cp_code`, `company_name` | CP |
| `city` | Gurgaon / Noida / Ghaziabad |
| `buyer_name`, `buyer_contact` | Buyer |
| `floor`, `furnishing_status`, `unit_address_line1/2`, `society_name`, `listing_status` (Sd/Rdy/Arc/Bkd/CS) | Property unit |
| `all_feedback` | Chronological log: `"DD-MMM - Follow-up Feedback: ..."` |
| `latest_followup_date`, `latest_followup_note`, `reminder_status` | Last action |
| `lead_key`, `lead_occurrence_count` | Buyer dedup, revisit count |
| `sales_feedback`, `buyer_feedback` | RM and buyer notes |

Property price is NOT on the visitors sheet — has to be joined from `live_inventory` by `society_name` (+ optionally unit address).

## 5. Brokers sheet (id `1bUkpfbceA7lLpMhRh2aoB-oGCwnzUiyD4sIclm25Z1k`)

- **Sheet1**: 4,681 brokers — full DB. Cols: id, name, phone, alternate, cp_code, company, city, added_by, localities, societies, societies_worked, micro_markets, visit_sales_managers, activity_category (L30_new / D30_active), per-month visit counts (dec/jan/feb), d30/60/90/all_time_visits.
- **stage**: tiny tab with `CP owner`, `Supply Team Owner`, `Demand Team Owner`, `lsq_lead_id`.
- **LeadSquare**: 4,873 brokers w/ `CP owner` as email (adiksha.sahu@…, joginder.singh@…, mukul.chhabra@…).

Tier 1 / Tier 2 flag is NOT on Sheet1 — only in `team.18 Broker Tiers` (read by CP Code).

## 6. Live inventory (id `1-kxlCnXUv7absl4rpWeMoYIxSAHpWykyjpd9v_5df-o`)

- **Sheet1**: 101 active properties. Cols: property_name, society_name, city_name, micro_market, locality_or_sector, listing_status (Ready/Coming Soon), configuration (BHK), super_sqft, carpet_sqft, exit_facing, balcony_view, listing_price ("86.5 L"), commission, **sales_manager (= Property Manager)**, photo_count, video_added.
- **All Properties**: 282 rows incl. archived.

## 7. Brand (Drive)

- Logo SVG: `Complete logo.svg` (full wordmark) + `Logo.svg` (icon only). Saved icon to `./brand/logo-icon.svg`.
- Primary orange: **#FA541C**
- Dark: **#161C24**

## 8. What v1 got wrong vs reality

- Made-up RMs (Priyesh, Rupali, Nisha) — real team is Aman/Shubham/Mukul/Mayank/Saket + Adiksha (TL).
- Made-up "rating" A+/A/B/C — reality is Tier 1/2/3/4.
- Showed buyer budget — reality: no budget field on visits, show property price (joined from live inventory).
- No hot/warm/cold/dead classifier exposure — it's the most important field.
- Single-team scoping — reality has 3 overlapping teams + people in multiple roles.
- No "to be assigned" queue — needed for new-CP triage.
- Followup cards always expanded — needs collapse/expand affordance.
- No property-manager mode — biggest missing view.
