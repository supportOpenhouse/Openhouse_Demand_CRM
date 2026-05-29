#!/usr/bin/env python3
"""Extract the real data slice the CRM needs into seed.json.

Pulls fresh from sheets (the CRM will eventually wire Neon).
"""
import os, json, csv, gspread
from collections import defaultdict
from pathlib import Path
from google.oauth2.service_account import Credentials

SA = os.environ.get(
    "GOOGLE_APPLICATION_CREDENTIALS",
    os.path.expanduser("~/.openhouse/credentials/service-account.json"),
)
if not os.path.exists(SA):
    raise SystemExit(
        f"Service account JSON not found at {SA}. "
        "Set GOOGLE_APPLICATION_CREDENTIALS or place the file at "
        "~/.openhouse/credentials/service-account.json"
    )
creds = Credentials.from_service_account_file(SA, scopes=["https://www.googleapis.com/auth/spreadsheets.readonly"])
gc = gspread.authorize(creds)

OUT = Path(__file__).parent / "seed.json"

# 1) Tier 1+2 list — sheet 18 Broker Tiers, list rows start at row 16
sh_team = gc.open_by_key("18XoHGVorN5cMOIJSvfqS2cS6teGi-iq98xwdCp3ZBjk")
ws = sh_team.worksheet("18 Broker Tiers")
v = ws.get_all_values()
# header at index 14
tier_header = v[14]
tier_rows = v[15:]
tier_idx = {h: i for i, h in enumerate(tier_header)}
print("tier header:", tier_header)
tiers = {}  # cp_code -> { tier, rank, city, name, company, phone, sold, bookings, ... }
for r in tier_rows:
    if not r or len(r) < 5 or not r[tier_idx["CP Code"]].strip():
        continue
    cp = r[tier_idx["CP Code"]].strip()
    tiers[cp] = {
        "tier": r[tier_idx["Tier"]].strip(),  # Gold / Silver
        "rank_in_city": int(r[tier_idx["Rank in City"]] or 0),
        "city": r[tier_idx["City"]].strip(),
        "name": r[tier_idx["Broker Name"]].strip(),
        "company": r[tier_idx["Company"]].strip(),
        "phone": r[tier_idx["Phone"]].strip(),
        "consistent": r[tier_idx["Consistent (≥3 vpm Mar/Apr/May)"]].strip(),
        "mar_visits": int(r[tier_idx["Mar Visits"]] or 0),
        "apr_visits": int(r[tier_idx["Apr Visits"]] or 0),
        "may_visits": int(r[tier_idx["May Visits"]] or 0),
        "total_mar_may": int(r[tier_idx["Total Visits Mar-May"]] or 0),
        "has_sold": r[tier_idx["Has Sold (Ever)"]].strip(),
        "sales_attributed": int(r[tier_idx["Total Sales Attributed"]] or 0),
        "bookings_apr_may": int(r[tier_idx["Bookings Apr-May"]] or 0),
        "bookings_mar_may": int(r[tier_idx["Bookings Mar-May"]] or 0),
        "all_time_visits": int(r[tier_idx["All-time Completed Visits"]] or 0),
        "onboarded_by": r[tier_idx["Onboarded By"]].strip(),
        "onboarded_on": r[tier_idx["Onboarded On"]].strip(),
    }
print(f"tier 1+2 brokers: {len(tiers)}")

# 2) Brokers DB — Sheet1 (lighter slice: top recent + all tiered)
sh_brk = gc.open_by_key("1bUkpfbceA7lLpMhRh2aoB-oGCwnzUiyD4sIclm25Z1k")
ws = sh_brk.worksheet("Sheet1")
v = ws.get_all_values()
brk_header = v[0]
bi = {h: i for i, h in enumerate(brk_header)}
all_brokers = {}
def get(r, k): return r[bi[k]] if k in bi and bi[k] < len(r) else ""
for r in v[1:]:
    cp = get(r, "cp_code").strip()
    if not cp:
        continue
    all_brokers[cp] = {
        "id": get(r, "id"),
        "name": get(r, "name").strip(),
        "phone_number": get(r, "phone_number").strip(),
        "alternate_number": get(r, "alternate_number").strip() if get(r, "alternate_number") and get(r, "alternate_number")!="None" else "",
        "created_at": get(r, "created_at").strip(),
        "localities": get(r, "localities").strip() if get(r, "localities")!="None" else "",
        "societies": get(r, "societies").strip() if get(r, "societies")!="None" else "",
        "cp_code": cp,
        "company_name": get(r, "company_name").strip(),
        "city": get(r, "city").strip(),
        "added_by": get(r, "added_by").strip(),
        "d30_visits": int(get(r, "d30_visits") or 0),
        "d60_visits": int(get(r, "d60_visits") or 0),
        "d90_visits": int(get(r, "d90_visits") or 0),
        "all_time_visits": int(get(r, "all_time_visits") or 0),
        "societies_worked": get(r, "societies_worked").strip(),
        "visit_sales_managers": get(r, "visit_sales_managers").strip(),
        "activity_category": get(r, "activity_category").strip(),
        "micro_markets": get(r, "micro_markets").strip(),
        "dec_visits": int(get(r, "dec_visits") or 0),
        "jan_visits": int(get(r, "jan_visits") or 0),
        "feb_visits": int(get(r, "feb_visits") or 0),
    }
print(f"total brokers in db: {len(all_brokers)}")

# 3) Visits — last 400 by created_at desc
sh_vis = gc.open_by_key("17eEX021t97pGnJasMJ6v7ERE0jezKEC0S8teKepJRWQ")
ws = sh_vis.worksheet("Sheet1")
v = ws.get_all_values()
vis_header = v[0]
vi = {h: i for i, h in enumerate(vis_header)}
def gv(r, k):
    if k not in vi or vi[k] >= len(r): return ""
    val = r[vi[k]].strip()
    return "" if val == "None" else val

# sort by created_at desc
data = v[1:]
data.sort(key=lambda r: r[vi["created_at"]], reverse=True)
visits = []
for r in data[:400]:
    visits.append({
        "id": gv(r, "id"),
        "selected_date": gv(r, "selected_date"),
        "selected_time": gv(r, "selected_time"),
        "visit_date": gv(r, "visit_date"),
        "status": gv(r, "status"),
        "lead_status": gv(r, "lead_status"),
        "sales_manager": gv(r, "sales_manager"),
        "sales_feedback": gv(r, "sales_feedback"),
        "buyer_feedback": gv(r, "buyer_feedback"),
        "source": gv(r, "source"),
        "broker_name": gv(r, "broker_name"),
        "broker_contact": gv(r, "broker_contact"),
        "cp_code": gv(r, "cp_code"),
        "company_name": gv(r, "company_name"),
        "city": gv(r, "city"),
        "buyer_name": gv(r, "buyer_name"),
        "buyer_contact": gv(r, "buyer_contact"),
        "buyer_registration_date": gv(r, "buyer_registration_date"),
        "added_by": gv(r, "added_by"),
        "floor": gv(r, "floor"),
        "furnishing_status": gv(r, "furnishing_status"),
        "unit_address_line1": gv(r, "unit_address_line1"),
        "unit_address_line2": gv(r, "unit_address_line2"),
        "society_name": gv(r, "society_name"),
        "all_feedback": gv(r, "all_feedback"),
        "lead_key": gv(r, "lead_key"),
        "lead_occurrence_count": gv(r, "lead_occurrence_count"),
        "first_added_by": gv(r, "first_added_by"),
        "latest_followup_date": gv(r, "latest_followup_date"),
        "latest_followup_note": gv(r, "latest_followup_note"),
        "reminder_status": gv(r, "reminder_status"),
        "listing_status": gv(r, "listing_status"),
        "time_spent_on_site": gv(r, "time_spent_on_site"),
        "society_amenity_tour": gv(r, "society_amenity_tour"),
        "price_discussion": gv(r, "price_discussion"),
        "client_queries": gv(r, "client_queries"),
        "closing_signal": gv(r, "closing_signal"),
        "buyer_primary_concern": gv(r, "buyer_primary_concern"),
        "profession": gv(r, "profession"),
        "created_at": gv(r, "created_at"),
        "updated_at": gv(r, "updated_at"),
    })
print(f"visits sampled: {len(visits)}")

# CPs referenced by these visits (so the CRM has the broker record loaded)
referenced_cps = set(v["cp_code"] for v in visits if v["cp_code"])
# Also pull all 250 tiered + top ~100 most active brokers
ranked = sorted(all_brokers.values(), key=lambda b: b["all_time_visits"], reverse=True)
top_active = {b["cp_code"] for b in ranked[:120]}
brokers_subset = {}
for cp in (referenced_cps | set(tiers.keys()) | top_active):
    if cp in all_brokers:
        b = dict(all_brokers[cp])
        t = tiers.get(cp)
        if t:
            b["tier"] = "T1" if t["tier"] == "Gold" else "T2"
            b["tier_rank"] = t["rank_in_city"]
            b["has_sold"] = t["has_sold"]
            b["sales_attributed"] = t["sales_attributed"]
            b["bookings_apr_may"] = t["bookings_apr_may"]
        else:
            # Tier inference: D30 active = T3, else T4
            if b["activity_category"] == "D30_active": b["tier"] = "T3"
            else: b["tier"] = "T4"
            b["tier_rank"] = 0
        brokers_subset[cp] = b
print(f"brokers in seed: {len(brokers_subset)}")

# 4) Live inventory
sh_inv = gc.open_by_key("1-kxlCnXUv7absl4rpWeMoYIxSAHpWykyjpd9v_5df-o")
ws = sh_inv.worksheet("Sheet1")
v = ws.get_all_values()
inv_header = v[1]
ih = {h: i for i, h in enumerate(inv_header)}
properties = []
for r in v[2:]:
    if not r or not r[0].strip():
        continue
    def gi(k):
        if k not in ih or ih[k] >= len(r): return ""
        return r[ih[k]].strip()
    properties.append({
        "property_name": gi("property_name"),
        "society_name": gi("society_name"),
        "city_name": gi("city_name"),
        "micro_market": gi("micro_market"),
        "locality_or_sector": gi("locality_or_sector"),
        "listing_status": gi("listing_status"),
        "configuration": gi("configuration"),
        "super_sqft": gi("super_sqft"),
        "carpet_sqft": gi("carpet_sqft"),
        "exit_facing": gi("exit_facing"),
        "balcony_view": gi("balcony_view"),
        "listing_price": gi("listing_price"),
        "commission": gi("commission"),
        "sales_manager": gi("sales_manager"),  # PM
        "photo_count": gi("photo_count"),
        "video_added": gi("video_added"),
    })
print(f"properties: {len(properties)}")

# 5) "To Be Assigned" candidates: brokers whose added_by is not a PM
pm_names = set(p["sales_manager"] for p in properties if p["sales_manager"])
# Brokers created in last 60 days whose added_by is not a known PM
import datetime as dt
to_assign = []
today = dt.date(2026, 5, 28)
for cp, b in all_brokers.items():
    if cp in brokers_subset: continue  # already included
    try: created = dt.date.fromisoformat(b["created_at"][:10])
    except Exception: continue
    if (today - created).days > 60: continue
    if b["added_by"] in pm_names: continue  # PM-onboarded → auto-assigned
    to_assign.append({**b, "tier": "T4", "tier_rank": 0})
to_assign = sorted(to_assign, key=lambda b: b["created_at"], reverse=True)[:30]
# also drop these into brokers_subset for lookup
for b in to_assign:
    brokers_subset[b["cp_code"]] = b
print(f"to-assign: {len(to_assign)}")

out = {
    "tiers_meta": {
        "T1": {"label":"Gold","count":sum(1 for b in tiers.values() if b["tier"]=="Gold")},
        "T2": {"label":"Silver","count":sum(1 for b in tiers.values() if b["tier"]=="Silver")},
    },
    "brokers": list(brokers_subset.values()),
    "visits": visits,
    "properties": properties,
    "to_assign_cps": [b["cp_code"] for b in to_assign],
    "generated_at": dt.datetime.utcnow().isoformat() + "Z",
}
OUT.write_text(json.dumps(out))
print(f"wrote {OUT} ({OUT.stat().st_size//1024} KB)")
