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
          v.source, v.status, v.selected_date, v.selected_time, v.visit_date,
          v.society_name, v.unit_address_line1, v.unit_address_line2, v.floor,
          v.furnishing_status, v.listing_status, v.sales_feedback, v.buyer_feedback,
          v.all_feedback, v.reminder_status, v.profession, v.intent, v.metadata,
          v.lead_status, v.current_stage, v.latest_followup_date, v.latest_followup_note,
          v.next_followup_date, v.revisit_date,
          v.created_at, v.updated_at
          FROM visits v
         ORDER BY v.visit_date DESC NULLS LAST, v.created_at DESC
         LIMIT $1
        """,
        config.SEED_VISITS_LIMIT,
    )
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
            "sales_manager": rm_override or (r["sales_manager"] or ""),
            "sales_feedback": r["sales_feedback"] or "",
            "buyer_feedback": r["buyer_feedback"] or "",
            "source": r["source"] or "",
            "broker_name": r["broker_name"] or "",
            "broker_contact": r["broker_contact"] or "",
            "broker_alt_contact": r["broker_alt_contact"] or "",
            "cp_code": r["cp_code"] or "",
            "company_name": r["company_name"] or "",
            "city": r["city"] or "",
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
            "created_at": _date_str(r["created_at"]),
            "updated_at": _date_str(r["updated_at"]),
        }
        # _stage / _next_followup_date / _revisit_date are the local overrides the frontend
        # reads via visitStage()/nextFuFor(). Carry them through so the projection survives a reload.
        if r["current_stage"]:
            visit["_stage"] = r["current_stage"]
        if r["next_followup_date"]:
            visit["_next_followup_date"] = _date_str(r["next_followup_date"])
        if r["revisit_date"]:
            visit["_revisit_date"] = r["revisit_date"].isoformat() if isinstance(r["revisit_date"], (dt.date, dt.datetime)) else str(r["revisit_date"])
        visits.append(visit)

    # --- properties + pm_by_property ----------------------------------------
    property_rows = await conn.fetch(
        """
        SELECT p.id, p.property_name, p.society_name, p.city, p.micro_market,
               p.locality_or_sector, p.listing_status, p.configuration,
               p.super_sqft, p.carpet_sqft, p.exit_facing, p.balcony_view,
               p.listing_price, p.commission, p.sales_manager,
               p.photo_count, p.video_added,
               u.slug AS pm_slug
          FROM properties p
     LEFT JOIN v_property_current_pm pa ON pa.property_id = p.id
     LEFT JOIN users u ON u.id = pa.pm_user_id
         WHERE p.deleted_at IS NULL
        """
    )
    properties = []
    pm_by_property: dict[str, str] = {}
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
            "photo_count": r["photo_count"] or "",
            "video_added": r["video_added"] or "",
        })
        if r["pm_slug"]:
            pm_by_property[r["property_name"]] = r["pm_slug"]

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
               n.type, n.ref_type, n.ref_id, n.text, n.action, n.read_at, n.created_at
          FROM notifications n
          JOIN users u ON u.id = n.to_user_id
     LEFT JOIN users fu ON fu.id = n.from_user_id
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
        "refId": str(r["ref_id"]) if r["ref_id"] else None,
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

    # tiers_meta (counts of current T1/T2)
    tier_counts = await conn.fetch(
        "SELECT tier, COUNT(*) AS c FROM tier_assignments "
        "WHERE effective_to IS NULL GROUP BY tier"
    )
    counts_map = {r["tier"]: r["c"] for r in tier_counts}

    return {
        "tiers_meta": {
            "T1": {"label": "Gold",   "count": counts_map.get("T1", 0)},
            "T2": {"label": "Silver", "count": counts_map.get("T2", 0)},
        },
        "brokers": brokers,
        "visits": visits,
        "properties": properties,
        "to_assign_cps": to_assign_cps,
        "cp_owner": cp_owner,
        "pm_by_property": pm_by_property,
        "nudges_by_visit": nudges_by_visit,
        "notifications": notifications,
        "team_tasks": team_tasks,
        "generated_at": dt.datetime.now(dt.timezone.utc).isoformat(),
    }
