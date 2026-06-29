"""Build the JSON snapshot the frontend's loadSeed() consumes.

Output shape is intentionally identical to seed.json so crm.html only needs to
change its fetch URL — every field name matches the legacy sheet-derived schema.
"""
from __future__ import annotations

import datetime as dt
import json

import asyncpg

from . import config


def _date_str(v) -> str:
    if v is None:
        return ""
    if isinstance(v, (dt.date, dt.datetime)):
        return v.isoformat()
    return str(v)


def _intent_str(intent: dict | None, key: str) -> str:
    if not intent:
        return ""
    return str(intent.get(key, "") or "")


# Cities with no KAM structure: the Ground property managers there see EVERY lead +
# every CP (all tiers) in the city, not just their assigned societies (there's no KAM
# to own the channel partners). Only Ground PMs whose `cities` include one of these are
# affected — every other user, role and city stays byte-identical, and KAMs are untouched.
# KEEP IN SYNC with the frontend NO_KAM_GROUND_CITIES (lib/visits.js, lib/brokers.js).
NO_KAM_GROUND_CITIES = {"Ghaziabad"}


def scope_for_user(snap: dict, user: dict) -> dict:
    """Public entry: scope the snapshot for `user`, then trim the meeting-recording
    markers to that same scope (additive; a no-op when the feature is dormant)."""
    _scope_for_user_core(snap, user)
    _scope_recordings(snap, user)
    return snap


def _scope_recordings(snap: dict, user: dict) -> None:
    """Trim the 🎙 marker maps to exactly the brokers/visits already in `snap`.
    Admin keeps everything; Report ends up empty (its brokers/visits were blanked).
    No NEW scoping logic — it rides the existing broker/visit scope. The conducting
    RM's own out-of-scope recordings are served by the recordings tab, not here."""
    by_cp = snap.get("meeting_recordings_by_cp")
    by_visit = snap.get("meeting_recordings_by_visit")
    if not by_cp and not by_visit:
        return
    if user.get("team") == "Admin":
        return
    visible_cps = {b["cp_code"] for b in snap.get("brokers", [])}
    visible_visits = {str(v["id"]) for v in snap.get("visits", [])}
    snap["meeting_recordings_by_cp"] = {cp: a for cp, a in (by_cp or {}).items() if cp in visible_cps}
    snap["meeting_recordings_by_visit"] = {vc: a for vc, a in (by_visit or {}).items() if vc in visible_visits}


def _scope_for_user_core(snap: dict, user: dict) -> dict:
    """Trim the full snapshot to what `user` is allowed to see, mirroring the
    frontend's visitsForUser()/brokersForUser()/propertiesForUser() exactly so
    no view breaks. Mutates and returns `snap` (a fresh dict per request).

    Admin is returned untouched — admins see everything and the impersonation
    switcher relies on the full dataset being present client-side.

    Note: this builds the full snapshot first, then filters in Python. Fine at
    current volume; push the predicates into SQL if /api/seed gets slow.
    """
    team = user.get("team")
    if team == "Admin":
        return snap

    # Report-only viewer (e.g. supply team): can browse the full property list to
    # generate seller reports, but sees nothing else — no leads, brokers, visits,
    # queues or notifications. The report itself is built server-side per home_id
    # (POST /api/reports/property), so the empty visits list here doesn't limit it.
    # Deny-by-default: 'Report' != 'Admin', so every _require_admin route already 403s.
    if team == "Report":
        snap["brokers"] = []
        snap["cp_owner"] = {}
        snap["engagements"] = {}
        snap["followups"] = []
        snap["visits"] = []
        snap["to_assign_cps"] = []
        snap["nudges_by_visit"] = {}
        snap["notifications"] = []
        snap["team_tasks"] = {}
        # properties left intact — the picker needs every live unit (Booked/Ready/Coming Soon).
        return snap

    role = user.get("role")
    slug = user["slug"]                       # frontend convention: broker owner id == slug
    name = user.get("name") or ""
    cities = set(user.get("cities") or [])

    brokers = snap["brokers"]
    visits = snap["visits"]
    properties = snap["properties"]
    cp_owner = snap["cp_owner"]

    # T3/T4 CPs are visible to EVERYONE (the frontend sorts the viewer's own first).
    # Every scoped role keeps its own set PLUS all T3/T4.
    t34 = {b["cp_code"] for b in brokers if b.get("tier") in ("T3", "T4")}

    def keep_brokers(codes):
        codes = codes | t34
        snap["brokers"] = [b for b in brokers if b["cp_code"] in codes]
        snap["cp_owner"] = {cp: o for cp, o in cp_owner.items() if cp in codes}
        # engagement + followup history follow the broker they belong to.
        # `codes` already includes all T3/T4 (t34), so history on ownerless T3/T4
        # CPs stays visible to everyone — same rule as the brokers themselves.
        snap["engagements"] = {cp: e for cp, e in snap.get("engagements", {}).items() if cp in codes}
        snap["followups"] = [f for f in snap.get("followups", []) if f.get("cp_code") in codes]

    # ── MM-manager: micro-market scope takes PRECEDENCE over team/city. A user with
    # micro_markets set sees every property + visit in those micro-markets (across all
    # PMs/RMs there), plus their own PM societies / RM visits. Only triggers when
    # micro_markets is set, so no other user is affected. Edit rights come from the
    # user's team (these managers are TLs → the frontend already grants TL edit).
    mms = set(user.get("micro_markets") or [])
    if mms:
        pm_by_property = snap.get("pm_by_property", {})
        my_props = {pn for pn, ps in pm_by_property.items() if ps == slug}
        in_scope_prop = lambda p: (p.get("micro_market") in mms) or (p["property_name"] in my_props)
        mm_socs = {p["society_name"] for p in properties if in_scope_prop(p)}
        mm_homeids = {p["home_id"] for p in properties if in_scope_prop(p) and p.get("home_id")}
        def _in_mm(v):
            return ((v.get("home_id") and v["home_id"] in mm_homeids)
                    or v["society_name"] in mm_socs
                    or v.get("sales_manager_raw", v["sales_manager"]) == name)
        codes = {b["cp_code"] for b in brokers if cp_owner.get(b["cp_code"]) == slug}
        for v in visits:
            if _in_mm(v) and v["cp_code"]:
                codes.add(v["cp_code"])
        keep_brokers(codes)
        snap["properties"] = [p for p in properties if in_scope_prop(p)]
        snap["visits"] = [v for v in visits if _in_mm(v)]
        _scope_personal(snap, slug)
        return snap

    if team == "TL" or role in ("kam_tl", "caller_tl"):
        # TLs and the calling-team lead (kam_tl) see the team, not a personal book.
        # City-scope only single-city TLs / closers; multi-city leads see everything.
        if role == "tl_closer" or len(cities) == 1:
            keep_brokers({b["cp_code"] for b in brokers if b["city"] in cities})
            snap["visits"] = [v for v in visits if v["city"] in cities]
            snap["properties"] = [p for p in properties if p["city_name"] in cities]
        # TLs manage the team + queue, so team_tasks / notifications / to_assign stay full.
        return snap

    if team == "KAM":
        owned = {b["cp_code"] for b in brokers if cp_owner.get(b["cp_code"]) == slug}
        # Optional admin-granted extra-city visit access (per-KAM toggle). When enabled,
        # the KAM ALSO sees every visit in `extra_cities` (on top of their own CPs), plus
        # those visits' CPs so the cards/pop-ups resolve. Default off / empty {} → this is
        # a no-op and the KAM's scope is byte-identical to before (no other user touched).
        extra = set(user.get("extra_cities") or []) if user.get("extra_cities_enabled") else set()
        if extra:
            for v in visits:
                if v.get("city") in extra and v["cp_code"]:
                    owned.add(v["cp_code"])
        keep_brokers(owned)
        snap["visits"] = [v for v in visits
                          if cp_owner.get(v["cp_code"]) == slug
                          or (extra and v.get("city") in extra)]
        # KAMs keep ALL properties (they suggest inventory to buyers).
        _scope_personal(snap, slug)
        return snap

    if team == "Ground":
        # Scope by the AUTHORITATIVE assignment (pm_by_property / property_assignments),
        # not the inventory sheet's `sales_manager` text. The sheet stores some PMs by
        # FIRST NAME only ("Anuj" vs user "Anuj Kumar", "Ayush" vs "Ayush Ojha"), so an
        # exact full-name match silently hid their visits/properties (e.g. Anuj saw 0).
        # Match full name OR first name as the fallback.
        first = name.split(" ", 1)[0] if name else ""
        def _is_pm(sm):
            return bool(sm) and (sm == name or (first != "" and sm == first))
        pm_by_property = snap.get("pm_by_property", {})
        my_props = {pn for pn, ps in pm_by_property.items() if ps == slug}
        my_socs = {p["society_name"] for p in properties
                   if p["property_name"] in my_props or _is_pm(p["sales_manager"])}
        # Cities with no KAM (Ghaziabad): this PM sees every lead + every CP (all tiers)
        # there. Empty for PMs whose cities aren't in NO_KAM_GROUND_CITIES → no change.
        no_kam = cities & NO_KAM_GROUND_CITIES
        codes = set()
        for b in brokers:
            if (cp_owner.get(b["cp_code"]) == slug or b.get("added_by") == name
                    or (no_kam and b.get("city") in no_kam)):
                codes.add(b["cp_code"])
        for v in visits:
            if (v["society_name"] in my_socs
                    or _is_pm(v.get("sales_manager_raw", v["sales_manager"]))
                    or (no_kam and v.get("city") in no_kam)) and v["cp_code"]:
                codes.add(v["cp_code"])
        keep_brokers(codes)
        snap["properties"] = [p for p in properties if p["society_name"] in my_socs]
        # A Ground PM also sees visits they personally ran (they are the RM), even when
        # the property is managed by someone else and the CP isn't theirs (e.g. VST8592);
        # plus EVERY visit in a no-KAM city (Ghaziabad), since there's no KAM to route them.
        snap["visits"] = [v for v in visits
                          if v["society_name"] in my_socs or cp_owner.get(v["cp_code"]) == slug
                          or _is_pm(v.get("sales_manager_raw", v["sales_manager"]))
                          or (no_kam and v.get("city") in no_kam)]
        _scope_personal(snap, slug)
        return snap

    # Unknown team → only the universally-visible T3/T4, no visits/properties.
    keep_brokers(set())
    snap["visits"], snap["properties"] = [], []
    _scope_personal(snap, slug)
    return snap


def _scope_personal(snap: dict, slug: str) -> None:
    """For non-privileged users (KAM/Ground): hide the assignment queue and other
    users' notifications / daily tasks / nudges."""
    snap["to_assign_cps"] = []
    visit_codes = {v["id"] for v in snap["visits"]}
    snap["nudges_by_visit"] = {
        vc: arr for vc, arr in snap["nudges_by_visit"].items() if vc in visit_codes
    }
    snap["notifications"] = [n for n in snap["notifications"] if n.get("to") == slug]
    own_tasks = snap["team_tasks"].get(slug)
    snap["team_tasks"] = {slug: own_tasks} if own_tasks else {}


async def build(conn: asyncpg.Connection) -> dict:
    # --- brokers (with tier + assigned owner email/slug merged in) ----------
    broker_rows = await conn.fetch(
        """
        SELECT
          b.id, b.cp_code, b.name, b.phone, b.alt_phone, b.company, b.city,
          b.micro_markets, b.localities, b.societies, b.societies_worked,
          b.visit_sales_managers, b.activity_category, b.added_by,
          b.dec_visits, b.jan_visits, b.feb_visits,
          b.d30_visits, b.d60_visits, b.d90_visits, b.all_time_visits,
          b.has_sold, b.sales_attributed, b.bookings_apr_may, b.external_id,
          b.created_at,
          ta.tier, ta.tier_rank,
          ca.owner_user_id,
          u.slug AS owner_slug
          FROM brokers b
     LEFT JOIN v_broker_current_tier ta ON ta.broker_id = b.id
     LEFT JOIN v_broker_current_owner ca ON ca.broker_id = b.id
     LEFT JOIN users u ON u.id = ca.owner_user_id
         WHERE b.deleted_at IS NULL
        """
    )
    brokers = []
    cp_owner: dict[str, str] = {}
    for r in broker_rows:
        brokers.append({
            "id": r["external_id"] or str(r["id"]),
            "cp_code": r["cp_code"],
            "name": r["name"],
            "phone_number": r["phone"] or "",
            "alternate_number": r["alt_phone"] or "",
            "company_name": r["company"] or "",
            "city": r["city"] or "",
            "micro_markets": r["micro_markets"] or "",
            "localities": r["localities"] or "",
            "societies": r["societies"] or "",
            "societies_worked": r["societies_worked"] or "",
            "visit_sales_managers": r["visit_sales_managers"] or "",
            "activity_category": r["activity_category"] or "",
            "added_by": r["added_by"] or "",
            "dec_visits": r["dec_visits"] or 0,
            "jan_visits": r["jan_visits"] or 0,
            "feb_visits": r["feb_visits"] or 0,
            "d30_visits": r["d30_visits"] or 0,
            "d60_visits": r["d60_visits"] or 0,
            "d90_visits": r["d90_visits"] or 0,
            "all_time_visits": r["all_time_visits"] or 0,
            "has_sold": r["has_sold"] or "",
            "sales_attributed": r["sales_attributed"] or 0,
            "bookings_apr_may": r["bookings_apr_may"] or 0,
            "created_at": _date_str(r["created_at"]),
            "tier": r["tier"] or "T4",
            "tier_rank": r["tier_rank"] or 0,
        })
        if r["owner_slug"]:
            cp_owner[r["cp_code"]] = r["owner_slug"]

    # --- visits (most recent N for snapshot) --------------------------------
    visit_rows = await conn.fetch(
        """
        SELECT
          v.visit_code, v.cp_code, v.broker_name, v.broker_contact, v.broker_alt_contact,
          v.company_name, v.city, v.buyer_name, v.buyer_contact, v.buyer_registration_date,
          v.lead_key, v.lead_occurrence_count, v.first_added_by, v.added_by, v.sales_manager,
          v.source, v.status, v.selected_date, v.selected_time,
          COALESCE(v.visit_date, v.selected_date) AS visit_date,
          v.society_name, v.unit_address_line1, v.unit_address_line2, v.floor,
          v.furnishing_status, v.listing_status, v.sales_feedback, v.buyer_feedback,
          v.all_feedback, v.reminder_status, v.profession, v.intent, v.metadata,
          v.lead_status, v.current_stage, v.latest_followup_at, v.latest_followup_note,
          v.latest_followup_date, v.next_followup_date, v.revisit_date, v.negotiation_date,
          v.negotiation_happened, v.booking_received_date,
          v.created_at, v.updated_at, v.home_id, v.is_old_lead
          FROM visits v
         ORDER BY COALESCE(v.visit_date, v.selected_date) DESC NULLS LAST, v.created_at DESC
         LIMIT $1
        """,
        config.SEED_VISITS_LIMIT,
    )
    # Author of the latest DB followup per visit (app/LSQ saves). Sheet-sourced
    # followups have no author here — the frontend falls back to the visit RM.
    fu_author = {
        r["visit_code"]: r["slug"]
        for r in await conn.fetch(
            """
            SELECT DISTINCT ON (f.visit_id) vis.visit_code, u.slug
              FROM followups f
              JOIN visits vis ON vis.id = f.visit_id
              JOIN users u ON u.id = f.by_user_id
             ORDER BY f.visit_id, f.created_at DESC
            """
        )
        if r["visit_code"]
    }
    # home_id → authoritative city from the inventory mirror. A visit's own `city`
    # (Visitors sheet) is sometimes mis-entered (e.g. Ghaziabad societies tagged
    # Noida); when the visit maps to a known unit, trust the inventory city.
    # Also live_by_home_id: the unit's CURRENT inventory status (Ready / Coming Soon =
    # live), the authoritative source the AI-Suggestions "live inventory only" filter
    # reads — same mirror that maintains visits.is_old_lead. Kept server-side only
    # (get_seed pops it; it never reaches the browser).
    home_city = {}
    live_by_home_id = {}
    for r in await conn.fetch(
        "SELECT home_id, city, listing_status FROM all_properties "
        "WHERE home_id IS NOT NULL AND home_id <> ''"
    ):
        if r["city"]:
            home_city[r["home_id"]] = r["city"]
        live_by_home_id[r["home_id"]] = (r["listing_status"] or "").strip().lower() in ("ready", "coming soon")
    visits = []
    for r in visit_rows:
        intent = r["intent"] or {}
        if isinstance(intent, str):
            try:
                intent = json.loads(intent)
            except Exception:
                intent = {}
        meta = r["metadata"] or {}
        if isinstance(meta, str):
            try:
                meta = json.loads(meta)
            except Exception:
                meta = {}
        # An admin/TL bulk RM-reassign stores the new RM name in metadata.rm_override
        # (the sales_manager column gets clobbered by the next sheet sync; metadata doesn't).
        rm_override = meta.get("rm_override")
        visit = {
            "id": r["visit_code"] or "",
            "selected_date": _date_str(r["selected_date"]),
            "selected_time": r["selected_time"] or "",
            "visit_date": _date_str(r["visit_date"]),
            "status": r["status"] or "",
            "lead_status": r["lead_status"] or "select_status",
            # sales_manager = the RM SHOWN (display). A second pass below makes it follow
            # the unit's current PM assignment when one exists (so a handover updates the RM
            # everywhere automatically). sales_manager_raw = the original sheet/override value
            # that all SCOPING reads, so visibility is byte-identical to before.
            "sales_manager": rm_override or (r["sales_manager"] or ""),
            "sales_manager_raw": rm_override or (r["sales_manager"] or ""),
            "_has_rm_override": bool(rm_override),
            "sales_feedback": r["sales_feedback"] or "",
            "buyer_feedback": r["buyer_feedback"] or "",
            "source": r["source"] or "",
            "broker_name": r["broker_name"] or "",
            "broker_contact": r["broker_contact"] or "",
            "broker_alt_contact": r["broker_alt_contact"] or "",
            "cp_code": r["cp_code"] or "",
            "company_name": r["company_name"] or "",
            "city": home_city.get(r["home_id"]) or r["city"] or "",
            "buyer_name": r["buyer_name"] or "",
            "buyer_contact": r["buyer_contact"] or "",
            "buyer_registration_date": _date_str(r["buyer_registration_date"]),
            "added_by": r["added_by"] or "",
            "floor": r["floor"] or "",
            "furnishing_status": r["furnishing_status"] or "",
            "unit_address_line1": r["unit_address_line1"] or "",
            "unit_address_line2": r["unit_address_line2"] or "",
            "society_name": r["society_name"] or "",
            "all_feedback": r["all_feedback"] or "",
            "lead_key": r["lead_key"] or "",
            "lead_occurrence_count": str(r["lead_occurrence_count"] or 1),
            "first_added_by": r["first_added_by"] or "",
            "latest_followup_date": _date_str(r["latest_followup_date"]),
            "latest_followup_note": r["latest_followup_note"] or "",
            "reminder_status": r["reminder_status"] or "",
            "listing_status": r["listing_status"] or "",
            "time_spent_on_site": _intent_str(intent, "time_spent_on_site"),
            "society_amenity_tour": _intent_str(intent, "society_amenity_tour"),
            "price_discussion": _intent_str(intent, "price_discussion"),
            "client_queries": _intent_str(intent, "client_queries"),
            "closing_signal": _intent_str(intent, "closing_signal"),
            "buyer_primary_concern": _intent_str(intent, "buyer_primary_concern"),
            "profession": r["profession"] or "",
            # oh-core home id of the unit visited — the authoritative join key to a
            # property (set on both sides by the sheet sync). Empty for the ~1% of
            # visits the source sheet hasn't mapped yet (frontend falls back to
            # society/unit matching there).
            "home_id": r["home_id"] or "",
            # Negotiations tab: did the scheduled meeting happen (bool|None), and the
            # captured booking-received date ("" when unset). Projected from the latest
            # follow-up by the project_followup_onto_visit() trigger (migration 018).
            "negotiation_happened": r["negotiation_happened"],
            "booking_received_date": _date_str(r["booking_received_date"]),
            "created_at": _date_str(r["created_at"]),
            "updated_at": _date_str(r["updated_at"]),
        }
        # _stage is the worked pipeline stage — ONLY trust it when a real app follow-up
        # set it (latest_followup_at not null). Otherwise current_stage is the stale
        # NOT-NULL DEFAULT 'upcoming', which would mislabel completed/cancelled sheet
        # visits as upcoming; without _stage the frontend derives stage from status
        # (upcoming→Upcoming, completed→After-Visit-FU, cancelled→Cancelled).
        if r["current_stage"] and r["latest_followup_at"] is not None:
            visit["_stage"] = r["current_stage"]
        # Old lead = the visit's unit is no longer live inventory (not Ready/Coming
        # Soon in all_properties). Maintained on the column by sheet_sync.
        # sync_inactive_leads(); we just read it. (Replaces the old pre-1-May rule.)
        visit["is_old_lead"] = bool(r["is_old_lead"])
        if r["next_followup_date"]:
            visit["_next_followup_date"] = _date_str(r["next_followup_date"])
        if r["revisit_date"]:
            visit["_revisit_date"] = r["revisit_date"].isoformat() if isinstance(r["revisit_date"], (dt.date, dt.datetime)) else str(r["revisit_date"])
        if r["negotiation_date"]:
            visit["_negotiation_date"] = r["negotiation_date"].isoformat() if isinstance(r["negotiation_date"], (dt.date, dt.datetime)) else str(r["negotiation_date"])
        by = fu_author.get(r["visit_code"])
        if by:
            visit["latest_followup_by"] = by   # owner slug; frontend resolves to name
        visits.append(visit)

    # --- properties + pm_by_property ----------------------------------------
    property_rows = await conn.fetch(
        """
        SELECT p.id, p.property_name, p.society_name, p.city, p.micro_market,
               p.locality_or_sector, p.listing_status, p.configuration,
               p.super_sqft, p.carpet_sqft, p.exit_facing, p.balcony_view,
               p.listing_price, p.commission, p.sales_manager,
               p.photo_count, p.video_added,
               p.home_id, p.sales_manager_contact, p.supply_form_uid,
               u.slug AS pm_slug, u.name AS pm_name
          FROM properties p
     LEFT JOIN v_property_current_pm pa ON pa.property_id = p.id
     LEFT JOIN users u ON u.id = pa.pm_user_id
         WHERE p.deleted_at IS NULL
        """
    )
    properties = []
    pm_by_property: dict[str, str] = {}
    # Current PM *name* per unit (home_id) and per society — used to make the visit
    # RM column follow the authoritative property assignment, not the stale sheet
    # `sales_manager` (which lags a handover; see the per-visit override below).
    pm_name_by_home_id: dict[str, str] = {}
    _soc_pm_names: dict[str, set] = {}
    for r in property_rows:
        properties.append({
            "property_name": r["property_name"],
            "society_name": r["society_name"],
            "city_name": r["city"],
            "micro_market": r["micro_market"] or "",
            "locality_or_sector": r["locality_or_sector"] or "",
            "listing_status": r["listing_status"] or "Ready",
            "configuration": r["configuration"] or "",
            "super_sqft": r["super_sqft"] or "",
            "carpet_sqft": r["carpet_sqft"] or "",
            "exit_facing": r["exit_facing"] or "",
            "balcony_view": r["balcony_view"] or "",
            "listing_price": r["listing_price"] or "",
            "commission": r["commission"] or "",
            "sales_manager": r["sales_manager"] or "",
            "sales_manager_contact": r["sales_manager_contact"] or "",
            "photo_count": r["photo_count"] or "",
            "video_added": r["video_added"] or "",
            # New sheet-synced source-system ids (2026-06-07). home_id is the join
            # key visits map to; the others are carried for future use.
            "home_id": r["home_id"] or "",
            "supply_form_uid": r["supply_form_uid"] or "",
        })
        if r["pm_slug"]:
            pm_by_property[r["property_name"]] = r["pm_slug"]
        pm_nm = r["pm_name"]
        if pm_nm:
            if r["home_id"]:
                pm_name_by_home_id[str(r["home_id"])] = pm_nm
            if r["society_name"]:
                _soc_pm_names.setdefault(r["society_name"], set()).add(pm_nm)
    # Society → PM name only when the WHOLE society has a single assigned PM. A society
    # split across PMs (e.g. Godrej Oasis: 304/704/201→Puran, 204→Shubham) stays out of
    # this map, so home_id-less visits there fall back to the sheet RM (never mis-attributed).
    pm_name_by_society = {s: next(iter(n)) for s, n in _soc_pm_names.items() if len(n) == 1}

    # Make the RM SHOWN follow the unit's current PM assignment. Precedence:
    #   manual rm_override  >  current PM (by home_id, else single-PM society)  >  sheet RM.
    # Only `sales_manager` (display) changes; `sales_manager_raw` (scoping) is untouched, so
    # who-sees-what is unchanged. Resolves stale RMs after a society handover (e.g. Godrej
    # Oasis → Puran) without anyone having to re-key the visits sheet.
    for v in visits:
        if v.pop("_has_rm_override", False):
            continue  # an explicit admin/TL reassignment always wins
        pm = pm_name_by_home_id.get(v["home_id"]) or pm_name_by_society.get(v["society_name"])
        if pm:
            v["sales_manager"] = pm

    # --- to_assign_cps ------------------------------------------------------
    # Anything in brokers without an active cp_assignment is "to be assigned".
    to_assign = await conn.fetch(
        """
        SELECT b.cp_code
          FROM brokers b
     LEFT JOIN v_broker_current_owner co ON co.broker_id = b.id
         WHERE co.broker_id IS NULL
           AND b.deleted_at IS NULL
         ORDER BY b.created_at DESC NULLS LAST
         LIMIT 200
        """
    )
    to_assign_cps = [r["cp_code"] for r in to_assign]

    # --- nudges, notifications, daily tasks, followup-log projection --------
    nudge_rows = await conn.fetch(
        """
        SELECT n.id, n.visit_id, v.visit_code, n.from_user_id, n.to_user_id,
               fu.slug AS from_slug, tu.slug AS to_slug,
               n.message, n.created_at, n.resolved_at
          FROM nudges n
          JOIN visits v ON v.id = n.visit_id
          JOIN users fu ON fu.id = n.from_user_id
          JOIN users tu ON tu.id = n.to_user_id
         ORDER BY n.created_at DESC
         LIMIT 1000
        """
    )
    nudges_by_visit: dict[str, list] = {}
    for r in nudge_rows:
        nudges_by_visit.setdefault(r["visit_code"] or str(r["visit_id"]), []).append({
            "id": str(r["id"]),
            "from": r["from_slug"],
            "to": r["to_slug"],
            "message": r["message"] or "",
            "ts": r["created_at"].isoformat() if r["created_at"] else "",
            "resolved": r["resolved_at"] is not None,
        })

    notif_rows = await conn.fetch(
        """
        SELECT n.id, u.slug AS to_slug, fu.slug AS from_slug,
               n.type, n.ref_type, n.ref_id, n.text, n.action, n.read_at, n.created_at,
               vis.visit_code AS ref_visit_code
          FROM notifications n
          JOIN users u ON u.id = n.to_user_id
     LEFT JOIN users fu ON fu.id = n.from_user_id
     LEFT JOIN visits vis ON vis.id = n.ref_id AND n.ref_type = 'visit'
         WHERE n.created_at > now() - interval '30 days'
         ORDER BY n.created_at DESC
         LIMIT 2000
        """
    )
    notifications = [{
        "id": "N" + str(r["id"]),
        "ts": r["created_at"].isoformat() if r["created_at"] else "",
        "to": r["to_slug"],
        "from": r["from_slug"],
        "type": r["type"],
        "refType": r["ref_type"],
        # For visit refs, hand the frontend the visit_code it indexes by — NOT the
        # raw visits.id UUID, or the notification click can't resolve the visit.
        "refId": r["ref_visit_code"] or (str(r["ref_id"]) if r["ref_id"] else None),
        "text": r["text"],
        "action": r["action"],
        "read": r["read_at"] is not None,
    } for r in notif_rows]

    task_rows = await conn.fetch(
        """
        SELECT t.id, u.slug AS user_slug, t.kind, t.task_date,
               b.cp_code, t.message_text, t.message_priority,
               fu.slug AS from_slug, t.created_at
          FROM user_daily_tasks t
          JOIN users u ON u.id = t.user_id
     LEFT JOIN brokers b ON b.id = t.broker_id
     LEFT JOIN users fu ON fu.id = t.from_user_id
         WHERE t.task_date >= current_date - interval '7 days'
         ORDER BY t.task_date DESC, t.created_at DESC
        """
    )
    team_tasks: dict[str, dict] = {}
    for r in task_rows:
        tt = team_tasks.setdefault(r["user_slug"], {"daily_calls": [], "messages": []})
        if r["kind"] == "pinned_cp" and r["cp_code"]:
            if r["cp_code"] not in tt["daily_calls"]:
                tt["daily_calls"].append(r["cp_code"])
        elif r["kind"] == "message":
            tt["messages"].append({
                "id": "TM" + str(r["id"]),
                "from": r["from_slug"] or "",
                "text": r["message_text"] or "",
                "ts": r["created_at"].isoformat() if r["created_at"] else "",
                "priority": r["message_priority"] or "normal",
            })

    # --- engagements per CP (cp_code -> [entries], newest first) ----------
    # The save endpoint writes these; without surfacing them here the history was
    # only ever the author's local optimistic copy (invisible to teammates/admin
    # and lost on reload). Shape matches store.engagements in the frontend.
    eng_rows = await conn.fetch(
        """
        SELECT b.cp_code, u.slug AS by_slug, e.id, e.created_at,
               e.inventory_shared, e.recording_done, e.listing_done,
               e.listing_link, e.listing_followup_date, e.support_asked,
               e.support_details, e.remarks, e.notes,
               e.connected, e.outcome, e.followup_date
          FROM engagements e
          JOIN brokers b ON b.id = e.broker_id
          JOIN users   u ON u.id = e.by_user_id
         ORDER BY e.created_at DESC
        """
    )

    def _yn(v):
        return "yes" if v is True else "no" if v is False else None

    engagements: dict[str, list] = {}
    for r in eng_rows:
        cp = r["cp_code"]
        if not cp:
            continue
        engagements.setdefault(cp, []).append({
            "id": str(r["id"]),
            "ts": r["created_at"].isoformat() if r["created_at"] else "",
            "by": r["by_slug"],                       # author slug (id == slug in the frontend)
            "inventoryShared": _yn(r["inventory_shared"]),
            "recordingDone": _yn(r["recording_done"]),
            "listingDone": _yn(r["listing_done"]),
            "listingLink": r["listing_link"] or "",
            "listingFollowupDate": _date_str(r["listing_followup_date"]),
            "supportAsked": _yn(r["support_asked"]),
            "supportDetails": r["support_details"] or "",
            "remarks": r["remarks"] or "",
            "notes": r["notes"] or "",
            "connected": r["connected"] or "",          # connected | no_answer | busy | switched_off | wrong_number
            "outcome": r["outcome"] or "",              # set only when connected
            "followupDate": _date_str(r["followup_date"]),
        })

    # --- followup history (flat list, newest first) -----------------------
    # The visit record already carries the *latest* followup (date/note/by); this
    # is the full per-followup history the broker-popup timeline shows. Like
    # engagements, without surfacing it the timeline entries were the author's
    # local optimistic copy only (invisible to teammates/admin, lost on reload).
    # Shape matches store.followupLog in the frontend.
    fu_rows = await conn.fetch(
        """
        SELECT vis.visit_code, vis.cp_code, u.slug AS by_slug,
               f.created_at, f.buyer_status, f.stage, f.note,
               f.next_followup_date, f.revisit_date
          FROM followups f
          JOIN visits vis ON vis.id = f.visit_id
          JOIN users  u   ON u.id   = f.by_user_id
         ORDER BY f.created_at DESC
        """
    )
    followups = [{
        "ts": r["created_at"].isoformat() if r["created_at"] else "",
        "by": r["by_slug"],
        "cp_code": r["cp_code"] or "",
        "visit_id": r["visit_code"] or "",      # frontend keys followups by the sheet visit code
        "status": r["buyer_status"] or "",
        "stage": r["stage"] or "",
        "note": r["note"] or "",
        "next_date": _date_str(r["next_followup_date"]),
        "revisit_date": _date_str(r["revisit_date"]),
    } for r in fu_rows]

    # tiers_meta (counts of current T1/T2)
    tier_counts = await conn.fetch(
        "SELECT tier, COUNT(*) AS c FROM tier_assignments "
        "WHERE effective_to IS NULL GROUP BY tier"
    )
    counts_map = {r["tier"]: r["c"] for r in tier_counts}

    # --- full roster (DB is the source of truth; frontend merges over its
    # hardcoded USERS array so team/city/role edits show up without a code change) ---
    user_rows = await conn.fetch(
        "SELECT slug, email, name, phone, team, role, cities, micro_markets, extra_cities, extra_cities_enabled, active FROM users WHERE active ORDER BY name"
    )
    users = [{
        "id": r["slug"],                 # frontend convention: id == slug
        "slug": r["slug"],
        "email": r["email"],
        "name": r["name"],
        "phone": r["phone"] or "",       # so an edited phone shows on reopen (was dropped → "saved but blank")
        "team": r["team"],
        "role": r["role"],
        "cities": list(r["cities"] or []),
        "micro_markets": list(r["micro_markets"] or []),
        "extra_cities": list(r["extra_cities"] or []),
        "extra_cities_enabled": bool(r["extra_cities_enabled"]),
    } for r in user_rows]

    # --- meeting recordings: lightweight markers only (NO summary; the summary is
    # fetched on expand). Keyed by the resolved CRM anchors so the client renders 🎙
    # against the right CP / visit. Defensive — if the table is absent or the feature
    # is dormant the maps are empty and the seed is byte-identical to before. ---
    mr_by_cp: dict = {}
    mr_by_visit: dict = {}
    try:
        for r in await conn.fetch(
            "SELECT meeting_id, meeting_type, meeting_date, rm_name, "
            "broker_cp_code, visit_code, match_method FROM meeting_recordings "
            "WHERE broker_cp_code IS NOT NULL OR visit_code IS NOT NULL"
        ):
            m = {"id": str(r["meeting_id"]), "type": r["meeting_type"],
                 "date": _date_str(r["meeting_date"]), "rm": r["rm_name"] or "",
                 "method": r["match_method"] or ""}
            if r["broker_cp_code"]:
                mr_by_cp.setdefault(r["broker_cp_code"], []).append(m)
            if r["visit_code"]:
                mr_by_visit.setdefault(str(r["visit_code"]), []).append(m)
    except Exception:  # noqa: BLE001 — never let the recordings layer break the seed
        mr_by_cp, mr_by_visit = {}, {}

    return {
        "users": users,
        "engagements": engagements,
        "followups": followups,
        "tiers_meta": {
            "T1": {"label": "Gold",   "count": counts_map.get("T1", 0)},
            "T2": {"label": "Silver", "count": counts_map.get("T2", 0)},
        },
        "brokers": brokers,
        "visits": visits,
        "properties": properties,
        "live_by_home_id": live_by_home_id,   # server-side only (AI-Suggestions filter); popped by get_seed
        "to_assign_cps": to_assign_cps,
        "cp_owner": cp_owner,
        "pm_by_property": pm_by_property,
        "nudges_by_visit": nudges_by_visit,
        "notifications": notifications,
        "team_tasks": team_tasks,
        "meeting_recordings_by_cp": mr_by_cp,
        "meeting_recordings_by_visit": mr_by_visit,
        "generated_at": dt.datetime.now(dt.timezone.utc).isoformat(),
    }
