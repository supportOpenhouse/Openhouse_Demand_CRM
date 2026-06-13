"""Sheet-to-DB upsert. Runs the same data-shape logic as _build_seed.py but
writes into Postgres instead of seed.json. Idempotent. Logs to sheet_sync_log.

Four sources:
  1. broker_data_query           → brokers (+ tier_assignments via team sheet)
  2. visitors_data               → buyers + visits (denormalized columns mirror sheet)
  3. live_inventory · Sheet1     → properties (+ property_assignments via sales_manager)
  4. live_inventory · All Props  → all_properties (flat mirror, every listing status)

Called on a Render Cron Job every 15 min (via POST /admin/sync with bearer header).
"""
from __future__ import annotations

import datetime as dt
import json
import logging
import re
from typing import Any

import asyncpg

from . import config, sheets
from .db import acquire

log = logging.getLogger("sheet_sync")
TODAY_UTC = lambda: dt.datetime.now(dt.timezone.utc)


def _safe(v: str | None) -> str:
    if v is None:
        return ""
    v = str(v).strip()
    return "" if v in ("None", "nan", "NaN", "null") else v


def _int(v: Any) -> int:
    try:
        return int(float(_safe(v) or 0))
    except (TypeError, ValueError):
        return 0


def _date_or_none(v: str | None) -> dt.date | None:
    s = _safe(v)
    if not s:
        return None
    s = s[:10]
    try:
        return dt.date.fromisoformat(s)
    except ValueError:
        return None


async def _begin_run(conn: asyncpg.Connection, sheet_name: str, sheet_id: str, tab: str) -> str:
    row = await conn.fetchrow(
        "INSERT INTO sheet_sync_log (sheet_name, sheet_id, tab_name, run_started_at, status) "
        "VALUES ($1, $2, $3, now(), 'running') RETURNING id",
        sheet_name, sheet_id, tab,
    )
    return str(row["id"])


async def _finish_run(
    conn: asyncpg.Connection,
    run_id: str,
    seen: int,
    ins: int,
    upd: int,
    skipped: int,
    failed: int,
    errors: list,
    status: str = "success",
) -> None:
    await conn.execute(
        "UPDATE sheet_sync_log SET run_finished_at = now(), rows_seen = $2, "
        "rows_inserted = $3, rows_updated = $4, rows_skipped = $5, rows_failed = $6, "
        "errors = $7::jsonb, status = $8 WHERE id = $1",
        run_id, seen, ins, upd, skipped, failed,
        json.dumps(errors), status,
    )


# ---- BROKERS -----------------------------------------------------------------

async def sync_brokers(conn: asyncpg.Connection) -> dict:
    """Bulk upsert all brokers from the sheet via executemany chunks.
    ~4,700 rows finishes in 5-10 seconds vs ~15 min for row-by-row."""
    sheet_id = config.SHEET_ID_BROKERS
    rows = sheets.read_tab(sheet_id, "Sheet1")
    if not rows or len(rows) < 2:
        return {"seen": 0, "ins": 0, "upd": 0, "skipped": 0, "failed": 0}
    header = rows[0]
    idx = {h: i for i, h in enumerate(header)}

    def g(r, k):
        return _safe(r[idx[k]]) if (k in idx and idx[k] < len(r)) else ""

    run_id = await _begin_run(conn, "broker_data_query", sheet_id, "Sheet1")
    seen = skipped = failed = 0
    errors: list = []
    batch: list = []

    for r in rows[1:]:
        seen += 1
        cp = g(r, "cp_code")
        if not cp:
            skipped += 1
            continue
        try:
            batch.append((
                cp,
                g(r, "name"),
                g(r, "phone_number"),
                g(r, "alternate_number") or None,
                g(r, "company_name"),
                g(r, "city"),
                g(r, "micro_markets"),
                g(r, "localities"),
                g(r, "societies"),
                g(r, "societies_worked"),
                g(r, "visit_sales_managers"),
                g(r, "activity_category"),
                _int(g(r, "dec_visits")),
                _int(g(r, "jan_visits")),
                _int(g(r, "feb_visits")),
                _int(g(r, "d30_visits")),
                _int(g(r, "d60_visits")),
                _int(g(r, "d90_visits")),
                _int(g(r, "all_time_visits")),
                g(r, "added_by"),
                g(r, "id"),
                _date_or_none(g(r, "created_at")),
            ))
        except Exception as e:
            failed += 1
            if len(errors) < 20:
                errors.append({"cp_code": cp, "error": str(e)[:200]})

    upsert_sql = """
        INSERT INTO brokers (
          cp_code, name, phone, alt_phone, company, city,
          micro_markets, localities, societies, societies_worked, visit_sales_managers,
          activity_category, dec_visits, jan_visits, feb_visits,
          d30_visits, d60_visits, d90_visits, all_time_visits,
          added_by, external_id, source, synced_from_sheet_at, created_at, updated_at
        ) VALUES (
          $1,$2,$3,$4,$5,$6,
          $7,$8,$9,$10,$11,
          $12,$13,$14,$15,
          $16,$17,$18,$19,
          $20,$21,'sheet_sync', now(),
          COALESCE($22, now()),
          now()
        )
        ON CONFLICT (cp_code) DO UPDATE SET
          name = EXCLUDED.name,
          phone = EXCLUDED.phone,
          alt_phone = EXCLUDED.alt_phone,
          company = EXCLUDED.company,
          city = EXCLUDED.city,
          micro_markets = EXCLUDED.micro_markets,
          localities = EXCLUDED.localities,
          societies = EXCLUDED.societies,
          societies_worked = EXCLUDED.societies_worked,
          visit_sales_managers = EXCLUDED.visit_sales_managers,
          activity_category = EXCLUDED.activity_category,
          dec_visits = EXCLUDED.dec_visits,
          jan_visits = EXCLUDED.jan_visits,
          feb_visits = EXCLUDED.feb_visits,
          d30_visits = EXCLUDED.d30_visits,
          d60_visits = EXCLUDED.d60_visits,
          d90_visits = EXCLUDED.d90_visits,
          all_time_visits = EXCLUDED.all_time_visits,
          added_by = EXCLUDED.added_by,
          external_id = EXCLUDED.external_id,
          synced_from_sheet_at = now(),
          updated_at = now()
    """
    chunk = 500
    for i in range(0, len(batch), chunk):
        try:
            await conn.executemany(upsert_sql, batch[i:i+chunk])
        except Exception as e:
            failed += len(batch[i:i+chunk])
            if len(errors) < 20:
                errors.append({"chunk_start": i, "error": str(e)[:200]})

    # We can't distinguish ins vs upd cheaply in a bulk path; report both as 'upserted'.
    upserted = len(batch) - failed
    await _finish_run(conn, run_id, seen, 0, upserted, skipped, failed, errors,
                      status="partial" if failed else "success")
    return {"seen": seen, "ins": 0, "upd": upserted, "skipped": skipped, "failed": failed}


# ---- TIERS (from team sheet `18 Broker Tiers`) -------------------------------

async def sync_tiers(conn: asyncpg.Connection) -> dict:
    """Refresh tier_assignments from the team sheet. Closes outdated rows and
    opens new ones so the active assignment always matches the sheet."""
    sheet_id = config.SHEET_ID_TEAM
    rows = sheets.read_tab(sheet_id, "18 Broker Tiers")
    if not rows or len(rows) < 16:
        return {"applied": 0}

    # Header sits at row 15 (0-indexed 14) per _build_seed.py.
    header = rows[14]
    body = rows[15:]
    idx = {h: i for i, h in enumerate(header)}

    if "CP Code" not in idx:
        log.warning("18 Broker Tiers: 'CP Code' header missing — schema drifted")
        return {"applied": 0}

    run_id = await _begin_run(conn, "team_18_broker_tiers", sheet_id, "18 Broker Tiers")
    applied = 0
    for r in body:
        if not r or len(r) < 5:
            continue
        cp = _safe(r[idx["CP Code"]])
        if not cp:
            continue
        raw_tier = _safe(r[idx.get("Tier", -1)] if "Tier" in idx else "")
        tier = "T1" if raw_tier.lower() == "gold" else "T2" if raw_tier.lower() == "silver" else None
        if not tier:
            continue
        rank = _int(r[idx.get("Rank in City", -1)]) if "Rank in City" in idx else 0
        broker_row = await conn.fetchrow("SELECT id FROM brokers WHERE cp_code = $1", cp)
        if not broker_row:
            continue
        broker_id = broker_row["id"]
        # Is the current open assignment already this tier+rank?
        current = await conn.fetchrow(
            "SELECT tier, tier_rank FROM tier_assignments "
            "WHERE broker_id = $1 AND effective_to IS NULL",
            broker_id,
        )
        if current and current["tier"] == tier and (current["tier_rank"] or 0) == rank:
            continue
        # Close current, open new
        await conn.execute(
            "UPDATE tier_assignments SET effective_to = now() "
            "WHERE broker_id = $1 AND effective_to IS NULL",
            broker_id,
        )
        await conn.execute(
            "INSERT INTO tier_assignments (broker_id, tier, tier_rank, reason) "
            "VALUES ($1, $2, $3, 'sheet_sync')",
            broker_id, tier, rank,
        )
        applied += 1

    await _finish_run(conn, run_id, len(body), applied, 0, 0, 0, [])
    return {"applied": applied}


# ---- VISITS + BUYERS ---------------------------------------------------------

async def sync_visits(conn: asyncpg.Connection, limit: int | None = None) -> dict:
    """Bulk upsert visits via prefetched FK maps + executemany chunks.
    ~7,700 rows finishes in ~60 seconds vs ~75 min for row-by-row."""
    sheet_id = config.SHEET_ID_VISITS
    rows = sheets.read_tab(sheet_id, "Sheet1")
    if not rows or len(rows) < 2:
        return {"seen": 0, "ins": 0, "upd": 0, "skipped": 0, "failed": 0}
    header = rows[0]
    idx = {h: i for i, h in enumerate(header)}

    def g(r, k):
        return _safe(r[idx[k]]) if (k in idx and idx[k] < len(r)) else ""

    body = rows[1:]
    body.sort(key=lambda r: g(r, "created_at"), reverse=True)
    if limit is not None:
        body = body[:limit]

    run_id = await _begin_run(conn, "visitors_data", sheet_id, "Sheet1")
    seen = skipped = failed = 0
    errors: list = []

    # ---- 1. prefetch FK maps (3 small queries) ----
    brokers_by_cp = {r["cp_code"]: r["id"] for r in await conn.fetch("SELECT cp_code, id FROM brokers")}
    properties_by_soc = {
        r["society_name"]: r["id"]
        for r in await conn.fetch(
            "SELECT DISTINCT ON (society_name) society_name, id FROM properties ORDER BY society_name, updated_at DESC"
        )
    }
    buyers_by_lk = {
        r["lead_key"]: r["id"]
        for r in await conn.fetch("SELECT lead_key, id FROM buyers WHERE lead_key IS NOT NULL")
    }

    # ---- 2. bulk insert any new buyers (dedup within batch by lead_key) ----
    new_buyers: dict = {}
    for r in body:
        lk = g(r, "lead_key")
        if lk and lk not in buyers_by_lk and lk not in new_buyers:
            new_buyers[lk] = (
                lk,
                g(r, "buyer_name") or "Unknown",
                g(r, "buyer_contact"),
                _date_or_none(g(r, "buyer_registration_date")),
            )
    if new_buyers:
        try:
            await conn.executemany(
                "INSERT INTO buyers (lead_key, name, phone, registration_date) "
                "VALUES ($1, $2, $3, $4) ON CONFLICT (lead_key) DO NOTHING",
                list(new_buyers.values()),
            )
            # refresh
            buyers_by_lk = {
                r["lead_key"]: r["id"]
                for r in await conn.fetch("SELECT lead_key, id FROM buyers WHERE lead_key IS NOT NULL")
            }
        except Exception as e:
            errors.append({"phase": "buyers_bulk", "error": str(e)[:200]})

    # ---- 3. build visit rows in memory ----
    visit_rows: list = []
    for r in body:
        seen += 1
        visit_code = g(r, "id")
        if not visit_code:
            skipped += 1
            continue
        try:
            cp = g(r, "cp_code")
            soc = g(r, "society_name")
            lk = g(r, "lead_key")
            intent = {
                k: g(r, k)
                for k in (
                    "time_spent_on_site", "society_amenity_tour", "price_discussion",
                    "client_queries", "closing_signal", "buyer_primary_concern",
                )
                if g(r, k)
            }
            visit_rows.append((
                visit_code,
                buyers_by_lk.get(lk),
                brokers_by_cp.get(cp),
                properties_by_soc.get(soc),
                cp, g(r, "broker_name"), g(r, "broker_contact"), g(r, "broker_alt_contact"),
                g(r, "company_name"), g(r, "city"),
                g(r, "buyer_name") or "Unknown", g(r, "buyer_contact"),
                _date_or_none(g(r, "buyer_registration_date")),
                lk, _int(g(r, "lead_occurrence_count")) or 1,
                g(r, "first_added_by"), g(r, "added_by"), g(r, "sales_manager"),
                g(r, "source"), g(r, "status"),
                _date_or_none(g(r, "selected_date")), g(r, "selected_time"),
                # visit_date falls back to selected_date when the sheet cell is blank
                # (so 'Old Leads' / date filters have a date to work with). EXCLUDED
                # in the upsert reflects this coalesced value too.
                _date_or_none(g(r, "visit_date")) or _date_or_none(g(r, "selected_date")), soc,
                g(r, "unit_address_line1"), g(r, "unit_address_line2"),
                g(r, "floor"), g(r, "furnishing_status"),
                g(r, "listing_status"), g(r, "sales_feedback"), g(r, "buyer_feedback"),
                g(r, "all_feedback"), g(r, "reminder_status"), g(r, "profession"),
                json.dumps(intent),
                g(r, "lead_status"),
                _date_or_none(g(r, "latest_followup_date")),
                g(r, "latest_followup_note"),
                _date_or_none(g(r, "created_at")),
                g(r, "home_id") or None,
            ))
        except Exception as e:
            failed += 1
            if len(errors) < 20:
                errors.append({"visit_code": visit_code, "error": str(e)[:200]})

    # ---- 4. chunked bulk upsert ----
    upsert_sql = """
        INSERT INTO visits (
          visit_code, buyer_id, broker_id, property_id,
          cp_code, broker_name, broker_contact, broker_alt_contact,
          company_name, city, buyer_name, buyer_contact, buyer_registration_date,
          lead_key, lead_occurrence_count, first_added_by, added_by, sales_manager,
          source, status, selected_date, selected_time, visit_date, society_name,
          unit_address_line1, unit_address_line2, floor, furnishing_status,
          listing_status, sales_feedback, buyer_feedback, all_feedback,
          reminder_status, profession, intent,
          lead_status, latest_followup_date, latest_followup_note,
          synced_from_sheet_at, created_at, updated_at, home_id
        ) VALUES (
          $1,$2,$3,$4,
          $5,$6,$7,$8,
          $9,$10,$11,$12,$13,
          $14,$15,$16,$17,$18,
          $19,$20,$21,$22,$23,$24,
          $25,$26,$27,$28,
          $29,$30,$31,$32,
          $33,$34,$35::jsonb,
          COALESCE(NULLIF($36, ''), 'select_status'),
          $37,$38,
          now(), COALESCE($39, now()), now(), $40
        )
        ON CONFLICT (visit_code) DO UPDATE SET
          buyer_id = EXCLUDED.buyer_id,
          broker_id = EXCLUDED.broker_id,
          property_id = EXCLUDED.property_id,
          cp_code = EXCLUDED.cp_code,
          broker_name = EXCLUDED.broker_name,
          broker_contact = EXCLUDED.broker_contact,
          broker_alt_contact = EXCLUDED.broker_alt_contact,
          company_name = EXCLUDED.company_name,
          city = EXCLUDED.city,
          buyer_name = EXCLUDED.buyer_name,
          buyer_contact = EXCLUDED.buyer_contact,
          buyer_registration_date = EXCLUDED.buyer_registration_date,
          lead_key = EXCLUDED.lead_key,
          lead_occurrence_count = EXCLUDED.lead_occurrence_count,
          first_added_by = EXCLUDED.first_added_by,
          added_by = EXCLUDED.added_by,
          sales_manager = EXCLUDED.sales_manager,
          source = EXCLUDED.source,
          status = EXCLUDED.status,
          selected_date = EXCLUDED.selected_date,
          selected_time = EXCLUDED.selected_time,
          visit_date = EXCLUDED.visit_date,
          society_name = EXCLUDED.society_name,
          unit_address_line1 = EXCLUDED.unit_address_line1,
          unit_address_line2 = EXCLUDED.unit_address_line2,
          floor = EXCLUDED.floor,
          furnishing_status = EXCLUDED.furnishing_status,
          listing_status = EXCLUDED.listing_status,
          sales_feedback = EXCLUDED.sales_feedback,
          buyer_feedback = EXCLUDED.buyer_feedback,
          all_feedback = EXCLUDED.all_feedback,
          reminder_status = EXCLUDED.reminder_status,
          profession = EXCLUDED.profession,
          intent = EXCLUDED.intent,
          -- Only overwrite lead_status / latest_followup_* from sheet if
          -- no followups exist for the visit (those are the source of truth).
          lead_status = CASE WHEN visits.latest_followup_at IS NULL
                             THEN EXCLUDED.lead_status ELSE visits.lead_status END,
          latest_followup_date = CASE WHEN visits.latest_followup_at IS NULL
                                      THEN EXCLUDED.latest_followup_date ELSE visits.latest_followup_date END,
          latest_followup_note = CASE WHEN visits.latest_followup_at IS NULL
                                      THEN EXCLUDED.latest_followup_note ELSE visits.latest_followup_note END,
          home_id = EXCLUDED.home_id,
          synced_from_sheet_at = now(),
          updated_at = now()
    """
    chunk = 500
    for i in range(0, len(visit_rows), chunk):
        try:
            await conn.executemany(upsert_sql, visit_rows[i:i+chunk])
        except Exception as e:
            failed += len(visit_rows[i:i+chunk])
            if len(errors) < 20:
                errors.append({"chunk_start": i, "error": str(e)[:200]})

    upserted = len(visit_rows) - failed
    await _finish_run(conn, run_id, seen, 0, upserted, skipped, failed, errors,
                      status="partial" if failed else "success")
    return {"seen": seen, "ins": 0, "upd": upserted, "skipped": skipped, "failed": failed}


# ---- PROPERTIES + PM ASSIGNMENTS --------------------------------------------

async def sync_properties(conn: asyncpg.Connection) -> dict:
    sheet_id = config.SHEET_ID_INVENTORY
    rows = sheets.read_tab(sheet_id, "Sheet1")
    if not rows or len(rows) < 3:
        return {"seen": 0, "ins": 0, "upd": 0, "skipped": 0, "failed": 0}
    # Per _build_seed.py: header is at index 1 (row 2), data from row 3 down.
    header = rows[1]
    body = rows[2:]
    idx = {h: i for i, h in enumerate(header)}

    def g(r, k):
        return _safe(r[idx[k]]) if (k in idx and idx[k] < len(r)) else ""

    run_id = await _begin_run(conn, "live_inventory", sheet_id, "Sheet1")
    seen = ins = upd = skipped = failed = 0
    errors: list = []
    pm_changes = 0

    # PM resolver. PHONE IS THE PRIMARY KEY (sheet column `sales_manager_contact`),
    # because names are unreliable (spelling, first-vs-full). The inventory sheet's
    # PM phone matches users.phone 1:1, so we resolve by last-10-digits first and only
    # fall back to name (full, then unambiguous first name) when there's no phone match.
    def _last10(s):
        d = "".join(ch for ch in (s or "") if ch.isdigit())
        return d[-10:] if len(d) >= 10 else ""

    _user_rows = await conn.fetch("SELECT id, name, phone FROM users WHERE active")
    _by_phone: dict = {}
    _by_full: dict = {}
    _first_count: dict = {}
    _first_id: dict = {}
    for _u in _user_rows:
        ph = _last10(_u["phone"])
        if ph:
            _by_phone[ph] = _u["id"]
        _nm = (_u["name"] or "").strip()
        if not _nm:
            continue
        _by_full[_nm.lower()] = _u["id"]
        _fn = _nm.split(" ", 1)[0].lower()
        _first_count[_fn] = _first_count.get(_fn, 0) + 1
        _first_id[_fn] = _u["id"]

    def resolve_pm(pm_name, pm_contact):
        ph = _last10(pm_contact)
        if ph and ph in _by_phone:           # phone wins — robust to name spelling
            return _by_phone[ph]
        key = (pm_name or "").strip().lower()
        if not key:
            return None
        if key in _by_full:
            return _by_full[key]
        if _first_count.get(key) == 1:       # unambiguous first-name fallback
            return _first_id[key]
        return None

    for r in body:
        if not r or not _safe(r[0]):
            continue
        seen += 1
        prop_name = g(r, "property_name")
        if not prop_name:
            skipped += 1
            continue
        try:
            row = await conn.fetchrow(
                """
                INSERT INTO properties (
                  property_name, society_name, city, micro_market, locality_or_sector,
                  listing_status, configuration, super_sqft, carpet_sqft,
                  exit_facing, balcony_view, listing_price, commission,
                  sales_manager, photo_count, video_added,
                  home_id, supply_form_uid, sales_manager_contact,
                  synced_from_sheet_at, created_at, updated_at
                ) VALUES (
                  $1,$2,$3,$4,$5,
                  COALESCE(NULLIF($6,''), 'Ready'),$7,$8,$9,
                  $10,$11,$12,$13,
                  $14,$15,$16,
                  $17,$18,$19,
                  now(), now(), now()
                )
                ON CONFLICT (property_name) DO UPDATE SET
                  society_name = EXCLUDED.society_name,
                  city = EXCLUDED.city,
                  micro_market = EXCLUDED.micro_market,
                  locality_or_sector = EXCLUDED.locality_or_sector,
                  listing_status = EXCLUDED.listing_status,
                  configuration = EXCLUDED.configuration,
                  super_sqft = EXCLUDED.super_sqft,
                  carpet_sqft = EXCLUDED.carpet_sqft,
                  exit_facing = EXCLUDED.exit_facing,
                  balcony_view = EXCLUDED.balcony_view,
                  listing_price = EXCLUDED.listing_price,
                  commission = EXCLUDED.commission,
                  sales_manager = EXCLUDED.sales_manager,
                  photo_count = EXCLUDED.photo_count,
                  video_added = EXCLUDED.video_added,
                  home_id = EXCLUDED.home_id,
                  supply_form_uid = EXCLUDED.supply_form_uid,
                  sales_manager_contact = EXCLUDED.sales_manager_contact,
                  synced_from_sheet_at = now(),
                  updated_at = now()
                RETURNING id, sales_manager
                """,
                prop_name, g(r, "society_name"), g(r, "city_name"),
                g(r, "micro_market"), g(r, "locality_or_sector"),
                g(r, "listing_status"), g(r, "configuration"),
                g(r, "super_sqft"), g(r, "carpet_sqft"),
                g(r, "exit_facing"), g(r, "balcony_view"),
                g(r, "listing_price"), g(r, "commission"),
                g(r, "sales_manager"), g(r, "photo_count"), g(r, "video_added"),
                g(r, "home_id") or None, g(r, "supply_form_uid") or None,
                g(r, "sales_manager_contact") or None,
            )
            ins += 1 if not row else 0  # rough; ON CONFLICT path returns same shape
            # PM assignment refresh — phone first (sales_manager_contact), name fallback
            pm_user_id = resolve_pm(g(r, "sales_manager"), g(r, "sales_manager_contact"))
            if pm_user_id:
                current = await conn.fetchrow(
                    "SELECT pm_user_id FROM property_assignments "
                    "WHERE property_id = $1 AND effective_to IS NULL",
                    row["id"],
                )
                if not current or current["pm_user_id"] != pm_user_id:
                    await conn.execute(
                        "UPDATE property_assignments SET effective_to = now() "
                        "WHERE property_id = $1 AND effective_to IS NULL",
                        row["id"],
                    )
                    await conn.execute(
                        "INSERT INTO property_assignments (property_id, pm_user_id) "
                        "VALUES ($1, $2)",
                        row["id"], pm_user_id,
                    )
                    pm_changes += 1
        except Exception as e:
            failed += 1
            if len(errors) < 20:
                errors.append({"property_name": prop_name, "error": str(e)[:200]})

    await _finish_run(conn, run_id, seen, ins, max(0, seen - ins - skipped - failed),
                      skipped, failed, errors + [{"pm_changes": pm_changes}],
                      status="partial" if failed else "success")
    return {"seen": seen, "ins": ins, "upd": seen - ins - skipped - failed,
            "skipped": skipped, "failed": failed, "pm_changes": pm_changes}


# ---- ALL PROPERTIES (every listing status; "All Properties" tab) -------------

async def sync_all_properties(conn: asyncpg.Connection) -> dict:
    """Mirror the live-inventory sheet's 'All Properties' tab (every status,
    incl. Sold/Archived) into all_properties. Same row→column mapping as
    sync_properties (Sheet1) and upsert by property_name, but no PM-assignment
    side effects — this is a flat reference table."""
    sheet_id = config.SHEET_ID_INVENTORY
    rows = sheets.read_tab(sheet_id, "All Properties")
    if not rows or len(rows) < 3:
        return {"seen": 0, "ins": 0, "upd": 0, "skipped": 0, "failed": 0}
    # Same layout as Sheet1: row 1 = "Last refreshed…", header at row 2, data row 3+.
    header = rows[1]
    body = rows[2:]
    idx = {h: i for i, h in enumerate(header)}

    def g(r, k):
        return _safe(r[idx[k]]) if (k in idx and idx[k] < len(r)) else ""

    run_id = await _begin_run(conn, "all_properties", sheet_id, "All Properties")
    seen = skipped = failed = 0
    errors: list = []
    rows_out: list = []

    for r in body:
        if not r or not _safe(r[0]):
            continue
        seen += 1
        prop_name = g(r, "property_name")
        if not prop_name:
            skipped += 1
            continue
        try:
            rows_out.append((
                prop_name, g(r, "society_name"), g(r, "city_name"),
                g(r, "micro_market"), g(r, "locality_or_sector"),
                g(r, "configuration"), g(r, "super_sqft"), g(r, "carpet_sqft"),
                g(r, "area_unit"), g(r, "listing_price"), g(r, "commission"),
                g(r, "exit_facing"), g(r, "balcony_view"),
                g(r, "listing_status"), g(r, "photo_count"), g(r, "video_added"),
                g(r, "sales_manager"), g(r, "sales_manager_contact") or None,
                g(r, "home_id") or None, g(r, "supply_form_uid") or None,
            ))
        except Exception as e:
            failed += 1
            if len(errors) < 20:
                errors.append({"property_name": prop_name, "error": str(e)[:200]})

    upsert_sql = """
        INSERT INTO all_properties (
          property_name, society_name, city, micro_market, locality_or_sector,
          configuration, super_sqft, carpet_sqft, area_unit, listing_price, commission,
          exit_facing, balcony_view, listing_status, photo_count, video_added,
          sales_manager, sales_manager_contact, home_id, supply_form_uid,
          synced_from_sheet_at, created_at, updated_at
        ) VALUES (
          $1,$2,$3,$4,$5,
          $6,$7,$8,$9,$10,$11,
          $12,$13,COALESCE(NULLIF($14,''), 'Ready'),$15,$16,
          $17,$18,$19,$20,
          now(), now(), now()
        )
        ON CONFLICT (property_name) DO UPDATE SET
          society_name = EXCLUDED.society_name,
          city = EXCLUDED.city,
          micro_market = EXCLUDED.micro_market,
          locality_or_sector = EXCLUDED.locality_or_sector,
          configuration = EXCLUDED.configuration,
          super_sqft = EXCLUDED.super_sqft,
          carpet_sqft = EXCLUDED.carpet_sqft,
          area_unit = EXCLUDED.area_unit,
          listing_price = EXCLUDED.listing_price,
          commission = EXCLUDED.commission,
          exit_facing = EXCLUDED.exit_facing,
          balcony_view = EXCLUDED.balcony_view,
          listing_status = EXCLUDED.listing_status,
          photo_count = EXCLUDED.photo_count,
          video_added = EXCLUDED.video_added,
          sales_manager = EXCLUDED.sales_manager,
          sales_manager_contact = EXCLUDED.sales_manager_contact,
          home_id = EXCLUDED.home_id,
          supply_form_uid = EXCLUDED.supply_form_uid,
          synced_from_sheet_at = now(),
          updated_at = now()
    """
    chunk = 500
    for i in range(0, len(rows_out), chunk):
        try:
            await conn.executemany(upsert_sql, rows_out[i:i+chunk])
        except Exception as e:
            failed += len(rows_out[i:i+chunk])
            if len(errors) < 20:
                errors.append({"chunk_start": i, "error": str(e)[:200]})

    upserted = len(rows_out) - failed
    await _finish_run(conn, run_id, seen, 0, upserted, skipped, failed, errors,
                      status="partial" if failed else "success")
    return {"seen": seen, "ins": 0, "upd": upserted, "skipped": skipped, "failed": failed}


# ---- OLD-LEAD / DEAD RECLASSIFY (property-status based) ----------------------

async def sync_inactive_leads(conn: asyncpg.Connection) -> dict:
    """Old-lead + Buyer-Status='dead' for every visit whose unit is no longer
    live inventory — i.e. its home_id does NOT map to a 'Ready'/'Coming Soon' row
    in EITHER the live `properties` table OR the `all_properties` mirror. Checking
    both heals a home_id mismatch between the two inventory tabs: a unit that's live
    in Sheet1 (properties) but recorded in All Properties under a different home_id /
    an Archived status was being wrongly flagged old + dead. Covers Sold / Archived /
    Booked units AND visits with no listing record at all.

    This REPLACES the old pre-1-May date rule (migration 003 / 005). It runs as
    the LAST step of run_all() — after sync_visits has re-upserted lead_status
    from the sheet — so the sheet can never resurrect a dead lead: each cycle
    ends with inactive-property visits forced back to dead + old. Idempotent;
    the WHERE clause only touches rows whose classification actually changed."""
    res = await conn.execute(
        """
        WITH cls AS (
          SELECT v.id,
                 (bool_or(ap.listing_status IN ('Ready','Coming Soon'))
                  OR bool_or(p.listing_status IN ('Ready','Coming Soon'))) AS active
          FROM visits v
          LEFT JOIN all_properties ap
            ON ap.home_id = v.home_id AND ap.deleted_at IS NULL
          LEFT JOIN properties p
            ON p.home_id = v.home_id AND p.deleted_at IS NULL
          GROUP BY v.id
        )
        UPDATE visits v SET
          is_old_lead        = NOT COALESCE(cls.active, FALSE),
          lead_status        = CASE WHEN COALESCE(cls.active, FALSE) THEN v.lead_status        ELSE 'dead' END,
          current_status     = CASE WHEN COALESCE(cls.active, FALSE) THEN v.current_status     ELSE 'dead' END,
          -- dead leads carry no pending followup obligation (don't clutter FU-due lists)
          next_followup_date = CASE WHEN COALESCE(cls.active, FALSE) THEN v.next_followup_date ELSE NULL END,
          revisit_date       = CASE WHEN COALESCE(cls.active, FALSE) THEN v.revisit_date       ELSE NULL END,
          updated_at         = now()
        FROM cls
        WHERE cls.id = v.id
          AND ( v.is_old_lead IS DISTINCT FROM (NOT COALESCE(cls.active, FALSE))
                OR (NOT COALESCE(cls.active, FALSE)
                    AND (v.lead_status <> 'dead' OR v.current_status <> 'dead'
                         OR v.next_followup_date IS NOT NULL OR v.revisit_date IS NOT NULL)) )
        """
    )
    # res is like "UPDATE 1234" → pull the count for the run log
    try:
        updated = int(res.split()[-1])
    except (ValueError, IndexError, AttributeError):
        updated = None
    return {"reclassified": updated}


# ---- TOP-LEVEL ---------------------------------------------------------------

# ---- KEY-HANDOVER (AMA-register sheet → sheet_key_handovers) ------------------

def _norm_hdr(h: str) -> str:
    return re.sub(r"\s+", " ", (h or "").strip().lower())


def _kh_date(v: str | None) -> dt.date | None:
    """Parse the sheet's varied date formats (13-Oct-2024, 16 Feb 2026, 6-Apr-2026)."""
    s = _safe(v)
    if not s:
        return None
    try:
        return dt.date.fromisoformat(s[:10])
    except ValueError:
        pass
    try:
        from dateutil import parser as _dp
        return _dp.parse(s, dayfirst=True, fuzzy=True).date()
    except Exception:
        return None


async def sync_key_handovers(conn: asyncpg.Connection) -> dict:
    """Society Name / Unit No / City / Key Handover Date from the AMA-register
    sheet's Gurgaon / Noida-GN / Ghaziabad tabs → sheet_key_handovers. The header
    row is auto-detected per tab (Gurgaon has legend rows above it). Only rows with
    a society + unit + parseable KH date are kept."""
    sheet_id = config.SHEET_ID_KEY_HANDOVERS
    run_id = await _begin_run(conn, "key_handovers", sheet_id, "Gurgaon,Noida/GN,Ghaziabad")
    seen = skipped = failed = 0
    errors: list = []
    rows_out: dict = {}   # (society_lc, unit_lc) -> (city, society, unit, date, tab); last-wins

    for tab in ("Gurgaon", "Noida/GN", "Ghaziabad"):
        try:
            rows = sheets.read_tab(sheet_id, tab)
        except Exception as e:
            errors.append({"tab": tab, "error": str(e)[:200]})
            continue
        hdr_i = None
        for i, r in enumerate(rows[:8]):
            norm = [_norm_hdr(x) for x in r]
            if "society name" in norm and any("key handover" in x for x in norm):
                hdr_i = i
                break
        if hdr_i is None:
            errors.append({"tab": tab, "error": "header row not found"})
            continue
        idx = {_norm_hdr(h): j for j, h in enumerate(rows[hdr_i])}

        def col(*names):
            for n in names:
                if n in idx:
                    return idx[n]
            return -1

        ci_soc = col("society name", "society")
        ci_unit = col("unit no", "unit no.", "unit")
        ci_city = col("city")
        ci_kh = next((j for h, j in idx.items() if "key handover" in h), -1)
        if ci_soc < 0 or ci_unit < 0 or ci_kh < 0:
            errors.append({"tab": tab, "error": "missing society/unit/kh column"})
            continue
        for r in rows[hdr_i + 1:]:
            seen += 1
            soc = _safe(r[ci_soc]) if ci_soc < len(r) else ""
            unit = _safe(r[ci_unit]) if ci_unit < len(r) else ""
            kh = _kh_date(r[ci_kh]) if ci_kh < len(r) else None
            city = _safe(r[ci_city]) if (0 <= ci_city < len(r)) else ""
            if not soc or not unit or kh is None:
                skipped += 1
                continue
            rows_out[(soc.lower(), unit.lower())] = (city or None, soc, unit, kh, tab)

    upserted = 0
    if rows_out:
        try:
            await conn.executemany(
                """
                INSERT INTO sheet_key_handovers (city, society_name, unit_no, key_handover_date, source_tab, synced_at)
                VALUES ($1,$2,$3,$4,$5, now())
                ON CONFLICT (society_name, unit_no) DO UPDATE SET
                  city = EXCLUDED.city,
                  key_handover_date = EXCLUDED.key_handover_date,
                  source_tab = EXCLUDED.source_tab,
                  synced_at = now()
                """,
                list(rows_out.values()),
            )
            upserted = len(rows_out)
        except Exception as e:
            failed = len(rows_out)
            errors.append({"phase": "upsert", "error": str(e)[:200]})

    await _finish_run(conn, run_id, seen, 0, upserted, skipped, failed, errors,
                      status="partial" if (failed or errors) else "success")
    return {"seen": seen, "upserted": upserted, "skipped": skipped, "failed": failed, "tab_errors": len(errors)}


async def run_all() -> dict:
    """Run brokers → tiers → properties → visits in that order (FK dependencies),
    then reclassify old/dead leads off the freshly-synced property statuses."""
    out: dict = {}
    async with acquire() as conn:
        out["brokers"] = await sync_brokers(conn)
        # Tier sync is OFF by default — tiers + ownership are CRM-owned (imported
        # once from the CT-assignment sheet, then edited via the frontend). Running
        # it would roll those changes back. Flip ENABLE_TIER_SYNC=1 to restore it.
        if config.ENABLE_TIER_SYNC:
            out["tiers"] = await sync_tiers(conn)
        else:
            out["tiers"] = {"skipped": "ENABLE_TIER_SYNC is off"}
        out["properties"] = await sync_properties(conn)
        out["all_properties"] = await sync_all_properties(conn)
        out["visits"] = await sync_visits(conn, limit=config.SEED_VISITS_LIMIT)
        # MUST be last: re-derives old/dead from the just-synced all_properties,
        # overriding any lead_status the sheet upsert above restored.
        out["inactive_leads"] = await sync_inactive_leads(conn)
        # Key-handover sheet: refresh once per UTC day (first /admin/sync after
        # midnight ≈ 5:30 AM IST), not every 15 min — it reads ~1,165 rows.
        last_kh = await conn.fetchval(
            "SELECT max(run_started_at) FROM sheet_sync_log "
            "WHERE sheet_name = 'key_handovers' AND status IN ('success', 'partial')"
        )
        today = dt.datetime.now(dt.timezone.utc).date()
        if last_kh is None or last_kh.date() < today:
            out["key_handovers"] = await sync_key_handovers(conn)
        else:
            out["key_handovers"] = {"skipped": "already synced today"}
    return out
