"""FastAPI app. Three concerns:
  1. Auth (Google SSO + signed cookie)
  2. Read: /api/seed returns the snapshot shape crm.html consumes
  3. Write: followups, nudges, notif-read, daily tasks

CORS: credentials allowed from FRONTEND_ORIGIN only.
Cron: /admin/sync hit by Render Cron Job; gated by INTERNAL_CRON_TOKEN.
"""
from __future__ import annotations

import asyncio
import json
import logging
import re
import time
from contextlib import asynccontextmanager
from typing import Optional

import asyncpg

from fastapi import Depends, FastAPI, HTTPException, Request, Response, Header
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import RedirectResponse, JSONResponse, PlainTextResponse
from pydantic import BaseModel, Field

from . import ai_suggestions, auth, config, reports, seed_snapshot, sheet_sync
from .db import init_pool, close_pool, acquire

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(name)s %(levelname)s %(message)s")
log = logging.getLogger("api")


@asynccontextmanager
async def lifespan(app: FastAPI):
    await init_pool()
    log.info("DB pool initialized")
    try:
        yield
    finally:
        await close_pool()


app = FastAPI(title="OpenHouse Demand CRM API", version="1.0", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=[config.FRONTEND_ORIGIN],
    allow_credentials=True,
    allow_methods=["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
    allow_headers=["Content-Type", "Authorization", "X-Internal-Cron-Token"],
)


# ============================================================================
# Health
# ============================================================================

@app.get("/health")
async def health():
    async with acquire() as conn:
        v = await conn.fetchval("SELECT 1")
    return {"ok": v == 1, "service": "oh-demand-crm-api"}


# ============================================================================
# Auth
# ============================================================================

@app.get("/auth/google/start")
async def auth_start(next: Optional[str] = None):
    return RedirectResponse(auth.build_login_url(next), status_code=302)


@app.get("/auth/google/callback")
async def auth_callback(code: str, state: str):
    state_data = auth._read_state(state)
    info = await auth.exchange_code_for_userinfo(code)
    email = (info.get("email") or "").lower()
    if not email or not info.get("email_verified", True):
        raise HTTPException(400, "Google did not return a verified email")
    if not email.endswith("@" + config.ALLOWED_EMAIL_DOMAIN):
        raise HTTPException(403, f"Only @{config.ALLOWED_EMAIL_DOMAIN} accounts allowed")

    user = await auth.upsert_user_for_login(
        email=email, name=info.get("name") or email, picture=info.get("picture")
    )

    next_url = state_data.get("next") or config.FRONTEND_ORIGIN
    resp = RedirectResponse(next_url, status_code=302)
    auth.set_session_cookie(resp, str(user["id"]), email, user["slug"])
    return resp


@app.post("/auth/logout")
async def logout():
    resp = JSONResponse({"ok": True})
    auth.clear_session_cookie(resp)
    return resp


# Local review only (DEV_MODE=1) — log in as any roster user without Google.
# Disabled in production (DEV_MODE unset on Render).
#
# The React app (frontend/) is served by Vite in dev (`npm run dev` on :5173,
# which proxies /api,/auth,/health here) and by Vercel in prod — the backend no
# longer serves any static frontend. Sign in locally via the Vite origin:
#   http://localhost:5173/auth/dev_login?slug=<slug>
# The 302 to "/" then resolves against :5173 and Vite serves the app.
if config.DEV_MODE:
    @app.get("/auth/dev_login")
    async def dev_login(slug: str):
        async with acquire() as conn:
            u = await conn.fetchrow(
                "SELECT id, slug, email FROM users WHERE slug = $1 AND active", slug
            )
        if not u:
            raise HTTPException(404, f"No active user with slug={slug}")
        resp = RedirectResponse("/", status_code=302)
        auth.set_session_cookie(resp, str(u["id"]), u["email"], u["slug"])
        return resp


@app.get("/api/me")
async def me(user: dict = Depends(auth.current_user_or_none)):
    if not user:
        return JSONResponse({"signed_in": False, "login_url": "/auth/google/start"})
    return {
        "signed_in": True,
        "id": str(user["id"]),
        "slug": user["slug"],
        "email": user["email"],
        "name": user["name"],
        "team": user["team"],
        "role": user["role"],
        "cities": list(user["cities"] or []),
        "micro_markets": list(user.get("micro_markets") or []),
        "extra_cities": list(user.get("extra_cities") or []),
        "extra_cities_enabled": bool(user.get("extra_cities_enabled")),
    }


# ============================================================================
# Read · the snapshot the frontend loads
# ============================================================================

@app.get("/api/seed")
async def get_seed(user: dict = Depends(auth.current_user)):
    """Same JSON shape as the legacy seed.json — drop-in replacement for loadSeed().
    Adds `current_user` with the full DB record so the frontend can graft
    users that aren't in its hardcoded USERS array (admins added via DB)."""
    async with acquire() as conn:
        snapshot = await seed_snapshot.build(conn)
    # Trim to the viewer's scope (Admin gets everything). Mirrors the frontend's
    # own role filters so no view breaks, but stops a non-admin reading data
    # outside their scope from the raw payload.
    snapshot = seed_snapshot.scope_for_user(snapshot, user)
    snapshot["current_user_slug"] = user["slug"]
    snapshot["current_user"] = {
        "id": user["slug"],                   # frontend convention: id == slug
        "slug": user["slug"],
        "email": user["email"],
        "name": user["name"],
        "team": user["team"],
        "role": user["role"],
        "cities": list(user["cities"] or []),
        "micro_markets": list(user.get("micro_markets") or []),
        "extra_cities": list(user.get("extra_cities") or []),
        "extra_cities_enabled": bool(user.get("extra_cities_enabled")),
    }
    return snapshot


# ============================================================================
# Read · Top Brokers · 99acres (market intel from the imported CSV)
# ============================================================================

@app.get("/api/top-brokers")
async def get_top_brokers(user: dict = Depends(auth.current_user)):
    """All rows from top_brokers_99acres, ordered city → society → rank.
    Every CSV field is returned; the frontend renders them in full."""
    async with acquire() as conn:
        rows = await conn.fetch(
            """
            SELECT id, society, city, micro_market, rank, broker_name, agency,
                   listings_30d, listings_90d, listings_180d, listings_all,
                   latest_listing_date, latest_listing_link, agency_address,
                   other_ncr_societies, oh_match_type, oh_match_details, phone
              FROM top_brokers_99acres
             ORDER BY city NULLS LAST, society, rank NULLS LAST
            """
        )
    items = [{
        "id": r["id"],
        "society": r["society"],
        "city": r["city"] or "",
        "micro_market": r["micro_market"] or "",
        "rank": r["rank"],
        "broker_name": r["broker_name"] or "",
        "agency": r["agency"] or "",
        "listings_30d": r["listings_30d"] or 0,
        "listings_90d": r["listings_90d"] or 0,
        "listings_180d": r["listings_180d"] or 0,
        "listings_all": r["listings_all"] or 0,
        "latest_listing_date": r["latest_listing_date"].isoformat() if r["latest_listing_date"] else "",
        "latest_listing_link": r["latest_listing_link"] or "",
        "agency_address": r["agency_address"] or "",
        "other_ncr_societies": r["other_ncr_societies"] or "",
        "oh_match_type": r["oh_match_type"] or "",
        "oh_match_details": r["oh_match_details"] or "",
        "phone": r["phone"] or "",
    } for r in rows]
    return {"items": items, "count": len(items)}


class TopBrokerPhoneBody(BaseModel):
    phone: Optional[str] = None


@app.post("/api/top-brokers/{row_id}/phone")
async def set_top_broker_phone(row_id: int, body: TopBrokerPhoneBody,
                               user: dict = Depends(auth.current_user)):
    """Add / edit / clear the CRM-entered phone for a 99acres top-broker row.
    Any authenticated user may set it; an empty string clears it."""
    phone = (body.phone or "").strip() or None
    async with acquire() as conn:
        row = await conn.fetchrow(
            "UPDATE top_brokers_99acres SET phone = $1 WHERE id = $2 RETURNING id, phone",
            phone, row_id,
        )
    if not row:
        raise HTTPException(404, "Top-broker row not found")
    return {"ok": True, "id": row["id"], "phone": row["phone"] or ""}


# ============================================================================
# Read · Key-handover dates (from the optional acquisitions "properties" DB)
# ============================================================================

_kh_cache: dict = {"at": 0.0, "items": None}   # 5-min in-process cache
_KH_TTL = 300


def _kh_key(society: str, unit: str) -> str:
    """society (alnum, upper) + de-zeroed digit-runs of the unit — mirrors the
    frontend matcher so 'acquisitions wins' dedup uses the same key."""
    soc = re.sub(r"[^A-Z0-9]", "", (society or "").upper())
    digits = sorted({re.sub(r"^0+(?=\d)", "", d) for d in re.findall(r"\d+", unit or "")})
    return f"{soc}#{'|'.join(digits)}" if soc else ""


@app.get("/api/key-handovers")
async def key_handovers(user: dict = Depends(auth.current_user)):
    """society_name + unit_no + key_handover_date, MERGED from the acquisitions
    ("properties") DB AND our sheet_key_handovers table (AMA-register daily sync).
    Acquisitions wins on conflict (same society + flat-number); the sheet fills the
    gaps. The frontend matches these to our inventory for the Property-Status report.
    Degrades gracefully when either source is unreachable."""
    now = time.monotonic()
    if _kh_cache["items"] is not None and (now - _kh_cache["at"]) < _KH_TTL:
        return {"items": _kh_cache["items"], "source": "connected", "count": len(_kh_cache["items"]), "cached": True}

    def _row_to_item(r):
        return {"society": (r["society_name"] or "").strip(), "unit": (r["unit_no"] or "").strip(),
                "kh_date": r["key_handover_date"].isoformat() if r["key_handover_date"] else ""}

    # 1. acquisitions DB (authoritative; wins on conflict)
    acq_items, acq_source = [], "unset"
    if config.PROPERTIES_DATABASE_URL:
        try:
            conn = await asyncpg.connect(config.PROPERTIES_DATABASE_URL, timeout=8)
            try:
                rows = await conn.fetch(
                    "SELECT society_name, unit_no, key_handover_date "
                    "FROM properties WHERE key_handover_date IS NOT NULL", timeout=8,
                )
            finally:
                await conn.close()
            acq_items = [_row_to_item(r) for r in rows]
            acq_source = "connected"
        except Exception as e:  # noqa: BLE001 — never let a bad external DB break the page
            log.warning("key-handovers (acquisitions) fetch failed: %s", e)
            acq_source = "error"

    # 2. sheet-synced KH (our DB) — fills units the acquisitions DB doesn't cover
    sheet_items = []
    try:
        async with acquire() as conn:
            srows = await conn.fetch(
                "SELECT society_name, unit_no, key_handover_date "
                "FROM sheet_key_handovers WHERE key_handover_date IS NOT NULL"
            )
        sheet_items = [_row_to_item(r) for r in srows]
    except Exception as e:  # noqa: BLE001
        log.warning("key-handovers (sheet) fetch failed: %s", e)

    # 3. merge: acquisitions first, sheet only fills keys not already present
    seen = {_kh_key(it["society"], it["unit"]) for it in acq_items}
    items = list(acq_items)
    for it in sheet_items:
        k = _kh_key(it["society"], it["unit"])
        if k and k not in seen:
            seen.add(k); items.append(it)

    _kh_cache["items"] = items
    _kh_cache["at"] = now
    source = "connected" if (acq_source == "connected" or sheet_items) else acq_source
    return {"items": items, "source": source, "count": len(items),
            "acquisitions": len(acq_items), "sheet": len(sheet_items)}


# ============================================================================
# Write · followups
# ============================================================================

class FollowupBody(BaseModel):
    visit_code: str = Field(..., description="The sheet 'id' of the visit (e.g. '7820')")
    buyer_status: str = Field(..., description="hot|warm|cold|dead|future_prospect|unc")
    stage: str = Field(..., description="One of STAGES (avfu/revisit_scheduled/...)")
    note: str = Field(..., min_length=1, description="Mandatory free text")
    next_followup_date: Optional[str] = None
    revisit_date: Optional[str] = None
    negotiation_date: Optional[str] = None


VALID_BUYER_STATUSES = {"hot", "warm", "cold", "dead", "future_prospect", "unc"}
VALID_STAGES = {
    "upcoming", "avfu", "revisit_scheduled", "after_revisit_fu", "negotiation",
    "after_negotiation_fu", "booking", "ats", "future_prospect", "not_interested",
    "need_more", "cancelled",
}


@app.post("/api/followups")
async def save_followup(body: FollowupBody, user: dict = Depends(auth.current_user)):
    if body.buyer_status not in VALID_BUYER_STATUSES:
        raise HTTPException(400, f"Invalid buyer_status: {body.buyer_status}")
    if body.stage not in VALID_STAGES:
        raise HTTPException(400, f"Invalid stage: {body.stage}")
    # A dead lead carries no follow-up: ignore any next-followup / revisit dates the
    # client sent, and don't require a revisit date for it.
    is_dead = body.buyer_status == "dead"
    if not is_dead and body.stage == "revisit_scheduled" and not body.revisit_date:
        raise HTTPException(400, "revisit_scheduled requires revisit_date")
    if not is_dead and body.stage == "negotiation" and not body.negotiation_date:
        raise HTTPException(400, "negotiation requires negotiation_date")
    if not body.note.strip():
        raise HTTPException(400, "Note is mandatory")

    async with acquire() as conn:
        visit = await conn.fetchrow(
            "SELECT id, broker_id, cp_code FROM visits WHERE visit_code = $1",
            body.visit_code,
        )
        if not visit:
            raise HTTPException(404, f"Visit {body.visit_code} not found")

        if not await _can_edit_visit(conn, user, visit["id"]):
            raise HTTPException(403, "You don't have permission to edit this visit")

        prev = await conn.fetchrow(
            "SELECT current_stage, current_status FROM visits WHERE id = $1", visit["id"]
        )
        fu = await conn.fetchrow(
            """
            INSERT INTO followups (
              visit_id, by_user_id, buyer_status, stage, note,
              next_followup_date, revisit_date, negotiation_date,
              previous_stage, previous_status, source
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'app')
            RETURNING id, created_at
            """,
            visit["id"], user["id"], body.buyer_status, body.stage, body.note.strip(),
            None if is_dead else _date_or_none(body.next_followup_date),
            None if is_dead else _ts_or_none(body.revisit_date),
            None if is_dead else _ts_or_none(body.negotiation_date),
            prev["current_stage"], prev["current_status"],
        )

        # Resolve open nudges on this visit and notify the nudgers
        nudges = await conn.fetch(
            "UPDATE nudges SET resolved_at = now(), resolved_by_followup_id = $1 "
            "WHERE visit_id = $2 AND resolved_at IS NULL "
            "RETURNING from_user_id, message",
            fu["id"], visit["id"],
        )
        for n in nudges:
            await conn.execute(
                "INSERT INTO notifications (to_user_id, from_user_id, type, ref_type, ref_id, text, action) "
                "VALUES ($1, $2, 'nudge_resolved', 'visit', $3, $4, 'open_visit')",
                n["from_user_id"], user["id"], visit["id"],
                f"Your nudge on visit {body.visit_code} was actioned.",
            )

    return {"ok": True, "followup_id": str(fu["id"]), "resolved_nudges": len(nudges)}


# ============================================================================
# Write · nudges
# ============================================================================

class NudgeBody(BaseModel):
    visit_code: str
    message: str
    priority: str = "normal"


@app.post("/api/nudges")
async def add_nudge(body: NudgeBody, user: dict = Depends(auth.current_user)):
    if body.priority not in ("low", "normal", "high"):
        raise HTTPException(400, "priority must be low/normal/high")
    async with acquire() as conn:
        visit = await conn.fetchrow(
            "SELECT v.id, v.broker_id, co.owner_user_id "
            "FROM visits v "
            "LEFT JOIN v_broker_current_owner co ON co.broker_id = v.broker_id "
            "WHERE v.visit_code = $1",
            body.visit_code,
        )
        if not visit:
            raise HTTPException(404, "Visit not found")
        if not visit["owner_user_id"]:
            raise HTTPException(400, "Visit's CP has no current owner — cannot nudge")
        if visit["owner_user_id"] == user["id"]:
            raise HTTPException(400, "Cannot nudge yourself")

        nudge = await conn.fetchrow(
            "INSERT INTO nudges (visit_id, from_user_id, to_user_id, message, priority) "
            "VALUES ($1, $2, $3, $4, $5) RETURNING id, created_at",
            visit["id"], user["id"], visit["owner_user_id"], body.message, body.priority,
        )
        await conn.execute(
            "INSERT INTO notifications (to_user_id, from_user_id, type, ref_type, ref_id, text, action) "
            "VALUES ($1, $2, 'nudge', 'visit', $3, $4, 'open_visit')",
            visit["owner_user_id"], user["id"], visit["id"], body.message or "Nudge received",
        )
    return {"ok": True, "nudge_id": str(nudge["id"])}


# ============================================================================
# Write · notifications
# ============================================================================

@app.post("/api/notifications/{notif_id}/read")
async def mark_notif_read(notif_id: str, user: dict = Depends(auth.current_user)):
    nid = notif_id.removeprefix("N")
    try:
        nid_int = int(nid)
    except ValueError:
        raise HTTPException(400, "Invalid notification id")
    async with acquire() as conn:
        row = await conn.fetchrow(
            "UPDATE notifications SET read_at = now() "
            "WHERE id = $1 AND to_user_id = $2 AND read_at IS NULL "
            "RETURNING id",
            nid_int, user["id"],
        )
    return {"ok": True, "updated": bool(row)}


@app.post("/api/notifications/read_all")
async def mark_all_notifs_read(user: dict = Depends(auth.current_user)):
    async with acquire() as conn:
        await conn.execute(
            "UPDATE notifications SET read_at = now() "
            "WHERE to_user_id = $1 AND read_at IS NULL",
            user["id"],
        )
    return {"ok": True}


# ============================================================================
# Write · daily call list (pin / unpin a CP)
# ============================================================================

class PinBody(BaseModel):
    user_slug: str
    cp_code: str
    task_date: Optional[str] = None  # default: today


class UnpinBody(BaseModel):
    user_slug: str
    cp_code: str


@app.post("/api/daily_tasks/pin")
async def pin_cp(body: PinBody, user: dict = Depends(auth.current_user)):
    async with acquire() as conn:
        target = await conn.fetchrow("SELECT id, team FROM users WHERE slug = $1", body.user_slug)
        if not target:
            raise HTTPException(404, "Target user not found")
        # Permission: admin / TL can pin to anyone; KAM/Ground can only pin to themselves.
        if user["team"] in ("KAM", "Ground") and target["id"] != user["id"]:
            raise HTTPException(403, "Only Admin/TL can pin to other users")
        broker = await conn.fetchrow("SELECT id FROM brokers WHERE cp_code = $1", body.cp_code)
        if not broker:
            raise HTTPException(404, "Broker not found")
        d = _date_or_none(body.task_date)
        row = await conn.fetchrow(
            """
            INSERT INTO user_daily_tasks (user_id, task_date, kind, broker_id, from_user_id)
            VALUES ($1, COALESCE($2, current_date), 'pinned_cp', $3, $4)
            RETURNING id
            """,
            target["id"], d, broker["id"], user["id"],
        )
        await conn.execute(
            "INSERT INTO notifications (to_user_id, from_user_id, type, ref_type, ref_id, text, action) "
            "VALUES ($1, $2, 'task', 'broker', $3, $4, 'open_team')",
            target["id"], user["id"], broker["id"],
            f"A CP ({body.cp_code}) was pinned to your day.",
        )
    return {"ok": True, "task_id": str(row["id"])}


@app.post("/api/daily_tasks/unpin")
async def unpin_cp(body: UnpinBody, user: dict = Depends(auth.current_user)):
    async with acquire() as conn:
        target = await conn.fetchrow("SELECT id FROM users WHERE slug = $1", body.user_slug)
        if not target:
            raise HTTPException(404, "Target user not found")
        if user["team"] in ("KAM", "Ground") and target["id"] != user["id"]:
            raise HTTPException(403, "Only Admin/TL can unpin from other users")
        broker = await conn.fetchrow("SELECT id FROM brokers WHERE cp_code = $1", body.cp_code)
        if not broker:
            raise HTTPException(404, "Broker not found")
        result = await conn.execute(
            "DELETE FROM user_daily_tasks WHERE user_id = $1 AND broker_id = $2 "
            "AND task_date = current_date AND kind = 'pinned_cp'",
            target["id"], broker["id"],
        )
    return {"ok": True}


# ============================================================================
# Write · engagements
# ============================================================================

class EngagementBody(BaseModel):
    cp_code: str
    notes: str = Field(..., min_length=1, description="Mandatory free text")
    inventory_shared: Optional[bool] = None
    recording_done: Optional[bool] = None
    listing_done: Optional[bool] = None
    listing_link: Optional[str] = None
    listing_followup_date: Optional[str] = None
    support_asked: Optional[bool] = None
    support_details: Optional[str] = None
    remarks: Optional[str] = None
    connected: Optional[str] = None          # connected | no_answer | busy | switched_off | wrong_number
    outcome: Optional[str] = None            # set only when connected
    followup_date: Optional[str] = None


@app.post("/api/engagements")
async def save_engagement(body: EngagementBody, user: dict = Depends(auth.current_user)):
    if not body.notes.strip():
        raise HTTPException(400, "Notes are mandatory")
    async with acquire() as conn:
        broker = await conn.fetchrow("SELECT id FROM brokers WHERE cp_code = $1", body.cp_code)
        if not broker:
            raise HTTPException(404, f"Broker {body.cp_code} not found")
        if not await _can_engage_broker(conn, user, broker["id"]):
            raise HTTPException(403, "You don't own this CP")
        row = await conn.fetchrow(
            """
            INSERT INTO engagements (
              broker_id, by_user_id, inventory_shared, recording_done,
              listing_done, listing_link, listing_followup_date,
              support_asked, support_details, remarks, notes,
              connected, outcome, followup_date
            ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
            RETURNING id, created_at
            """,
            broker["id"], user["id"],
            body.inventory_shared, body.recording_done, body.listing_done,
            (body.listing_link or None), _date_or_none(body.listing_followup_date),
            body.support_asked, (body.support_details or None),
            (body.remarks or None), body.notes.strip(),
            (body.connected or None),
            # outcome only meaningful when connected
            (body.outcome or None) if body.connected == "connected" else None,
            _date_or_none(body.followup_date),
        )
    return {"ok": True, "engagement_id": str(row["id"])}


# ============================================================================
# Write · CP tier / owner (Admin only) + bulk (Admin/TL)
# ============================================================================

VALID_TIERS = {"T1", "T2", "T3", "T4"}


class TierBody(BaseModel):
    tier: str


class OwnerBody(BaseModel):
    owner_slug: Optional[str] = None  # null/empty → unassign


@app.post("/api/brokers/{cp_code}/tier")
async def set_broker_tier(cp_code: str, body: TierBody, user: dict = Depends(auth.current_user)):
    _require_admin(user)
    if body.tier not in VALID_TIERS:
        raise HTTPException(400, f"Invalid tier: {body.tier}")
    async with acquire() as conn:
        broker = await conn.fetchrow("SELECT id FROM brokers WHERE cp_code = $1", cp_code)
        if not broker:
            raise HTTPException(404, "Broker not found")
        async with conn.transaction():
            await _set_tier(conn, broker["id"], body.tier, user["id"], reason="manual")
    return {"ok": True}


@app.post("/api/brokers/{cp_code}/owner")
async def set_broker_owner(cp_code: str, body: OwnerBody, user: dict = Depends(auth.current_user)):
    _require_admin(user)
    async with acquire() as conn:
        broker = await conn.fetchrow("SELECT id FROM brokers WHERE cp_code = $1", cp_code)
        if not broker:
            raise HTTPException(404, "Broker not found")
        owner_id = await _slug_to_id(conn, body.owner_slug) if body.owner_slug else None
        if body.owner_slug and not owner_id:
            raise HTTPException(404, f"User {body.owner_slug} not found")
        async with conn.transaction():
            await _set_owner(conn, broker["id"], owner_id, user["id"], reason="manual")
    return {"ok": True, "owner_slug": body.owner_slug or None}


class BulkAssignBody(BaseModel):
    cp_codes: list[str]
    owner_slug: Optional[str] = None
    tier: Optional[str] = None
    note: Optional[str] = None


@app.post("/api/brokers/bulk_assign")
async def bulk_assign_brokers(body: BulkAssignBody, user: dict = Depends(auth.current_user)):
    _require_admin_or_tl(user)
    if not body.cp_codes:
        raise HTTPException(400, "No CPs provided")
    if not body.owner_slug and not body.tier:
        raise HTTPException(400, "Provide owner_slug and/or tier")
    if body.tier and body.tier not in VALID_TIERS:
        raise HTTPException(400, f"Invalid tier: {body.tier}")
    async with acquire() as conn:
        owner_id = await _slug_to_id(conn, body.owner_slug) if body.owner_slug else None
        if body.owner_slug and not owner_id:
            raise HTTPException(404, f"User {body.owner_slug} not found")
        applied = 0
        async with conn.transaction():
            for cp in body.cp_codes:
                broker = await conn.fetchrow("SELECT id FROM brokers WHERE cp_code = $1", cp)
                if not broker:
                    continue
                if owner_id:
                    await _set_owner(conn, broker["id"], owner_id, user["id"], reason="bulk_reassign")
                if body.tier:
                    await _set_tier(conn, broker["id"], body.tier, user["id"], reason="manual")
                applied += 1
    return {"ok": True, "applied": applied}


class VisitBulkReassignBody(BaseModel):
    visit_codes: list[str]
    rm_slug: str
    note: Optional[str] = None


@app.post("/api/visits/bulk_reassign")
async def bulk_reassign_visits(body: VisitBulkReassignBody, user: dict = Depends(auth.current_user)):
    _require_admin_or_tl(user)
    if not body.visit_codes:
        raise HTTPException(400, "No visits provided")
    async with acquire() as conn:
        rm = await conn.fetchrow("SELECT id, name FROM users WHERE slug = $1", body.rm_slug)
        if not rm:
            raise HTTPException(404, f"User {body.rm_slug} not found")
        # visits.sales_manager is overwritten by the 15-min sheet sync, but metadata
        # is never touched — store the override there and let seed_snapshot apply it.
        result = await conn.execute(
            """
            UPDATE visits
               SET sales_manager = $1,
                   metadata = jsonb_set(metadata, '{rm_override}', to_jsonb($1::text), true),
                   updated_at = now()
             WHERE visit_code = ANY($2::text[])
            """,
            rm["name"], body.visit_codes,
        )
    # result is like "UPDATE N"
    n = int(result.split()[-1]) if result and result.split()[-1].isdigit() else 0
    return {"ok": True, "reassigned": n}


# ============================================================================
# Write · Users / roster (Admin only)
# ============================================================================

VALID_TEAMS = {"Admin", "TL", "KAM", "Ground"}


class UserCreateBody(BaseModel):
    name: str = Field(..., min_length=1)
    email: str = Field(..., min_length=3)
    team: str
    role: str = Field(..., min_length=1)
    slug: Optional[str] = None             # auto-derived from name when blank
    phone: Optional[str] = None
    cities: list[str] = Field(default_factory=list)
    micro_markets: list[str] = Field(default_factory=list)
    extra_cities: list[str] = Field(default_factory=list)
    extra_cities_enabled: bool = False
    joined_at: Optional[str] = None


class UserUpdateBody(BaseModel):
    # All optional — only the keys present are changed (PATCH semantics).
    name: Optional[str] = None
    email: Optional[str] = None
    team: Optional[str] = None
    role: Optional[str] = None
    phone: Optional[str] = None
    cities: Optional[list[str]] = None
    micro_markets: Optional[list[str]] = None
    extra_cities: Optional[list[str]] = None
    extra_cities_enabled: Optional[bool] = None
    active: Optional[bool] = None


def _slugify(name: str) -> str:
    base = re.sub(r"[^a-z0-9]+", "-", (name or "").lower()).strip("-")
    return base or "user"


async def _unique_slug(conn, base: str) -> str:
    """First-free slug: base, base-2, base-3, … (matches the legacy first-name style)."""
    slug, n = base, 1
    while await conn.fetchval("SELECT 1 FROM users WHERE slug = $1", slug):
        n += 1
        slug = f"{base}-{n}"
    return slug


def _check_email_domain(email: str) -> str:
    email = (email or "").strip().lower()
    if "@" not in email or not email.endswith("@" + config.ALLOWED_EMAIL_DOMAIN):
        raise HTTPException(400, f"Email must be a @{config.ALLOWED_EMAIL_DOMAIN} address")
    return email


@app.post("/api/users")
async def create_user(body: UserCreateBody, user: dict = Depends(auth.current_user)):
    """Add a roster member. Admin only. Persists to the users table (the sheet
    sync never writes users, so manually-added people are not wiped)."""
    _require_admin(user)
    if body.team not in VALID_TEAMS:
        raise HTTPException(400, f"Invalid team: {body.team}")
    email = _check_email_domain(body.email)
    cities = [c.strip() for c in (body.cities or []) if c.strip()]
    mms = [m.strip() for m in (body.micro_markets or []) if m.strip()]
    extra = [c.strip() for c in (body.extra_cities or []) if c.strip()]
    async with acquire() as conn:
        if await conn.fetchval("SELECT 1 FROM users WHERE email = $1", email):
            raise HTTPException(409, "A user with this email already exists")
        requested = (body.slug or "").strip().lower()
        if requested:
            if not re.fullmatch(r"[a-z0-9-]+", requested):
                raise HTTPException(400, "Slug may only contain lowercase letters, numbers and hyphens")
            if await conn.fetchval("SELECT 1 FROM users WHERE slug = $1", requested):
                raise HTTPException(409, f"Slug '{requested}' is already taken")
            slug = requested
        else:
            slug = await _unique_slug(conn, _slugify(body.name))
        row = await conn.fetchrow(
            """
            INSERT INTO users (slug, email, name, phone, team, role, cities, micro_markets, extra_cities, extra_cities_enabled, joined_at, active)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, true)
            RETURNING slug, name
            """,
            slug, email, body.name.strip(), (body.phone or "").strip() or None,
            body.team, body.role.strip(), cities, mms, extra, bool(body.extra_cities_enabled), _date_or_none(body.joined_at),
        )
    return {"ok": True, "slug": row["slug"], "name": row["name"]}


@app.patch("/api/users/{slug}")
async def update_user(slug: str, body: UserUpdateBody, user: dict = Depends(auth.current_user)):
    """Edit a roster member (name/email/team/role/phone/cities) or set active
    (active=false = deactivate; drops out of the roster but keeps history/FKs).
    Admin only. The slug is immutable (it is the owner identity used elsewhere)."""
    _require_admin(user)
    if body.team is not None and body.team not in VALID_TEAMS:
        raise HTTPException(400, f"Invalid team: {body.team}")
    async with acquire() as conn:
        target = await conn.fetchrow("SELECT id, slug FROM users WHERE slug = $1", slug)
        if not target:
            raise HTTPException(404, "User not found")
        # Build the SET clause from a fixed whitelist of columns (no injection).
        fields: dict = {}
        if body.name is not None:
            if not body.name.strip():
                raise HTTPException(400, "Name cannot be empty")
            fields["name"] = body.name.strip()
        if body.email is not None:
            email = _check_email_domain(body.email)
            if await conn.fetchval("SELECT 1 FROM users WHERE email = $1 AND id <> $2", email, target["id"]):
                raise HTTPException(409, "Another user already uses this email")
            fields["email"] = email
        if body.team is not None:
            fields["team"] = body.team
        if body.role is not None:
            if not body.role.strip():
                raise HTTPException(400, "Role cannot be empty")
            fields["role"] = body.role.strip()
        if body.phone is not None:
            fields["phone"] = body.phone.strip() or None
        if body.cities is not None:
            fields["cities"] = [c.strip() for c in body.cities if c.strip()]
        if body.micro_markets is not None:
            fields["micro_markets"] = [m.strip() for m in body.micro_markets if m.strip()]
        if body.extra_cities is not None:
            fields["extra_cities"] = [c.strip() for c in body.extra_cities if c.strip()]
        if body.extra_cities_enabled is not None:
            fields["extra_cities_enabled"] = body.extra_cities_enabled
        if body.active is not None:
            fields["active"] = body.active
        if not fields:
            return {"ok": True, "slug": slug, "changed": 0}
        cols = list(fields.keys())
        set_clause = ", ".join(f"{c} = ${i + 2}" for i, c in enumerate(cols))
        await conn.execute(
            f"UPDATE users SET {set_clause}, updated_at = now() WHERE id = $1",
            target["id"], *[fields[c] for c in cols],
        )
    return {"ok": True, "slug": slug, "changed": len(fields)}


# ============================================================================
# Admin · Hiring planning (beta) — read-only table off all_properties + a manual
# micro-market fill for blank-MM societies. Admin-only. Touches no existing data:
# the GET only reads; the POST writes ONLY to the isolated hiring_mm_overrides
# table (migration 012), applied as a COALESCE fallback so it can never override
# a property's real MM.
# ============================================================================

@app.get("/api/hiring")
async def get_hiring(user: dict = Depends(auth.current_user)):
    _require_admin(user)
    async with acquire() as conn:
        rows = await conn.fetch(
            """
            SELECT ap.city,
                   COALESCE(NULLIF(ap.micro_market,''), ov.micro_market)  AS mm,
                   count(*) FILTER (WHERE ap.listing_status='Ready')       AS ready,
                   count(*) FILTER (WHERE ap.listing_status='Coming Soon') AS coming_soon,
                   count(*) FILTER (WHERE ap.listing_status='Archived')    AS archived
              FROM all_properties ap
              LEFT JOIN hiring_mm_overrides ov
                ON ov.city = ap.city AND ov.society_name = ap.society_name
             WHERE ap.deleted_at IS NULL
               AND ap.listing_status IN ('Ready','Coming Soon','Archived')
               AND COALESCE(NULLIF(ap.micro_market,''), ov.micro_market) IS NOT NULL
             GROUP BY 1, 2
            """
        )
        # currently-assigned PM count per live (city, micro-market) — authoritative
        pm = await conn.fetch(
            """
            SELECT p.city, NULLIF(p.micro_market,'') AS mm, count(DISTINCT pa.pm_user_id) AS pms
              FROM v_property_current_pm pa
              JOIN properties p ON p.id = pa.property_id AND p.deleted_at IS NULL
             WHERE NULLIF(p.micro_market,'') IS NOT NULL
             GROUP BY 1, 2
            """
        )
        blanks = await conn.fetch(
            """
            SELECT ap.city, ap.society_name, count(*) AS n
              FROM all_properties ap
              LEFT JOIN hiring_mm_overrides ov
                ON ov.city = ap.city AND ov.society_name = ap.society_name
             WHERE ap.deleted_at IS NULL
               AND ap.listing_status IN ('Ready','Coming Soon','Archived')
               AND COALESCE(NULLIF(ap.micro_market,''), ov.micro_market) IS NULL
             GROUP BY 1, 2
            """
        )
        overrides = await conn.fetch(
            "SELECT city, society_name, micro_market, set_by FROM hiring_mm_overrides ORDER BY city, society_name"
        )
    pmmap = {(r["city"], r["mm"]): r["pms"] for r in pm}
    table = [
        {
            "city": r["city"] or "", "mm": r["mm"] or "",
            "ready": r["ready"], "coming_soon": r["coming_soon"], "archived": r["archived"],
            "total": r["ready"] + r["coming_soon"] + r["archived"],
            "pms": pmmap.get((r["city"], r["mm"]), 0),
        }
        for r in rows
    ]
    return {
        "rows": table,
        "blanks": [{"city": b["city"] or "", "society_name": b["society_name"] or "", "n": b["n"]} for b in blanks],
        "overrides": [dict(o) for o in overrides],
    }


class HiringMmOverrideBody(BaseModel):
    city: str
    society_name: str
    micro_market: str  # blank → clear the override


@app.post("/api/hiring/mm-override")
async def set_hiring_mm_override(body: HiringMmOverrideBody, user: dict = Depends(auth.current_user)):
    _require_admin(user)
    city = (body.city or "").strip()
    soc = (body.society_name or "").strip()
    mm = (body.micro_market or "").strip()
    if not city or not soc:
        raise HTTPException(400, "city and society_name are required")
    async with acquire() as conn:
        if mm:
            await conn.execute(
                """
                INSERT INTO hiring_mm_overrides (city, society_name, micro_market, set_by)
                VALUES ($1, $2, $3, $4)
                ON CONFLICT (city, society_name)
                DO UPDATE SET micro_market = EXCLUDED.micro_market, set_by = EXCLUDED.set_by, updated_at = now()
                """,
                city, soc, mm, user["slug"],
            )
        else:
            await conn.execute(
                "DELETE FROM hiring_mm_overrides WHERE city = $1 AND society_name = $2", city, soc
            )
    return {"ok": True}


# ============================================================================
# Property Report mailer (Admin only)
# Build a seller-facing performance report from visit data (metrics reconcile with
# the Analytics tab, keyed on home_id), optionally summarise feedback with Claude,
# and drop it as a DRAFT into the triggering admin's own Gmail. Read-only against
# the CRM; the only side effect is the draft (gmail.compose, never send).
# ============================================================================

class ReportPreviewBody(BaseModel):
    home_id: str


class ReportDraftBody(BaseModel):
    home_id: str
    summary: Optional[dict] = None   # the structured summary returned by the preview
    subject: Optional[str] = None


@app.post("/api/reports/property")
async def report_preview(body: ReportPreviewBody, user: dict = Depends(auth.current_user)):
    _require_admin(user)
    async with acquire() as conn:
        data = await reports.build_report_data(conn, body.home_id)
    if not data:
        raise HTTPException(404, "No live property found for that home_id")
    label = data["property"].get("property_name") or data["property"].get("society_name") or ""
    # The Claude SDK call is blocking — run it off the event loop. Returns None when
    # ANTHROPIC_API_KEY is unset or there's no feedback (report still renders).
    summary = await asyncio.to_thread(
        reports.summarize_feedback, label, data["metrics"], data["feedback_items"]
    )
    html = reports.render_report_html(
        data["property"], data["metrics"], summary,
        user.get("name") or user.get("slug") or "", user.get("email") or "",
    )
    return {
        "property": data["property"],
        "metrics": data["metrics"],
        "summary": summary,
        "feedback_count": len(data["feedback_items"]),
        "subject": reports.default_subject(data["property"]),
        "html": html,
    }


@app.post("/api/reports/property/draft")
async def report_draft(body: ReportDraftBody, user: dict = Depends(auth.current_user)):
    _require_admin(user)
    async with acquire() as conn:
        data = await reports.build_report_data(conn, body.home_id)
    if not data:
        raise HTTPException(404, "No live property found for that home_id")
    # Re-render server-side from the previewed summary (no second Claude call). The
    # renderer HTML-escapes every dynamic field, so client-supplied summary text is safe.
    html = reports.render_report_html(
        data["property"], data["metrics"], body.summary,
        user.get("name") or user.get("slug") or "", user.get("email") or "",
    )
    subject = (body.subject or "").strip() or reports.default_subject(data["property"])
    try:
        result = await asyncio.to_thread(reports.create_gmail_draft, user["email"], subject, html)
    except reports.DelegationNotConfigured as e:
        raise HTTPException(503, str(e))
    except Exception as e:  # noqa: BLE001
        log.exception("gmail draft creation failed")
        raise HTTPException(502, f"Could not create the Gmail draft: {e}")
    return {"ok": True, "subject": subject, **result}


# ============================================================================
# AI Suggestions — per-user daily "morning brief" (all roles)
# A short, role-scoped brief (leads near closing, brokers to call with pending
# counts, status updates) built from each user's SCOPED data (reusing
# scope_for_user — identical who-sees-what) and prioritised by Claude. Cached one
# row per user per day. The 09:30-IST cron pre-generates everyone; the GET
# endpoint generates on-demand if today's brief is missing. Read-only on CRM data.
# ============================================================================

_AI_USER_COLS = ("id, slug, email, name, team, role, cities, micro_markets, "
                 "extra_cities, extra_cities_enabled, active")


async def _ai_upsert(conn, user_id, for_date, payload: dict) -> None:
    await conn.execute(
        """
        INSERT INTO ai_suggestions (user_id, for_date, payload)
        VALUES ($1, $2, $3::jsonb)
        ON CONFLICT (user_id, for_date)
        DO UPDATE SET payload = EXCLUDED.payload, generated_at = now()
        """,
        user_id, for_date, json.dumps(payload),
    )


def _ai_payload(row) -> dict:
    p = row["payload"]
    return json.loads(p) if isinstance(p, str) else p


@app.get("/api/ai-suggestions")
async def get_ai_suggestions(user: dict = Depends(auth.current_user)):
    today = _dt.date.today()
    async with acquire() as conn:
        row = await conn.fetchrow(
            "SELECT payload, generated_at FROM ai_suggestions WHERE user_id = $1 AND for_date = $2",
            user["id"], today,
        )
        if row:
            return {"payload": _ai_payload(row), "generated_at": row["generated_at"].isoformat(), "cached": True}
        snap = await seed_snapshot.build(conn)
    # first open of the day → generate on-demand (blocking SDK call off the loop), then cache
    payload = await asyncio.to_thread(ai_suggestions.build_for_user, snap, user, seed_snapshot.scope_for_user)
    async with acquire() as conn:
        await _ai_upsert(conn, user["id"], today, payload)
    return {"payload": payload, "generated_at": _dt.datetime.now(_dt.timezone.utc).isoformat(), "cached": False}


@app.post("/api/ai-suggestions/refresh")
async def refresh_ai_suggestions(user: dict = Depends(auth.current_user)):
    today = _dt.date.today()
    async with acquire() as conn:
        snap = await seed_snapshot.build(conn)
    payload = await asyncio.to_thread(ai_suggestions.build_for_user, snap, user, seed_snapshot.scope_for_user)
    async with acquire() as conn:
        await _ai_upsert(conn, user["id"], today, payload)
    return {"payload": payload, "generated_at": _dt.datetime.now(_dt.timezone.utc).isoformat(), "cached": False}


@app.post("/admin/generate-suggestions")
async def admin_generate_suggestions(x_internal_cron_token: str = Header(default="")):
    """Daily cron (09:30 IST). Pre-generates every active user's brief. Token-gated."""
    if not config.INTERNAL_CRON_TOKEN:
        raise HTTPException(503, "INTERNAL_CRON_TOKEN not configured")
    if x_internal_cron_token != config.INTERNAL_CRON_TOKEN:
        raise HTTPException(403, "Bad cron token")
    today = _dt.date.today()
    async with acquire() as conn:
        snap = await seed_snapshot.build(conn)
        users = [dict(u) for u in await conn.fetch(f"SELECT {_AI_USER_COLS} FROM users WHERE active")]
    sem = asyncio.Semaphore(5)   # modest concurrency on the Claude calls

    async def _one(u):
        async with sem:
            try:
                payload = await asyncio.to_thread(
                    ai_suggestions.build_for_user, snap, u, seed_snapshot.scope_for_user)
                return u["id"], payload
            except Exception:  # one user's failure must not abort the batch
                log.exception("ai brief failed for %s", u.get("slug"))
                return None

    results = [r for r in await asyncio.gather(*[_one(u) for u in users]) if r]
    async with acquire() as conn:
        for uid, payload in results:
            await _ai_upsert(conn, uid, today, payload)
    return {"ok": True, "generated": len(results), "users": len(users)}


# ============================================================================
# Admin · sync trigger (used by Render Cron Job)
# ============================================================================

@app.post("/admin/sync")
async def admin_sync(request: Request, x_internal_cron_token: str = Header(default="")):
    if not config.INTERNAL_CRON_TOKEN:
        raise HTTPException(503, "INTERNAL_CRON_TOKEN not configured")
    if x_internal_cron_token != config.INTERNAL_CRON_TOKEN:
        raise HTTPException(403, "Bad cron token")
    out = await sheet_sync.run_all()
    return {"ok": True, "result": out}


# ============================================================================
# Helpers
# ============================================================================

import datetime as _dt


def _date_or_none(s: Optional[str]) -> Optional[_dt.date]:
    if not s:
        return None
    try:
        return _dt.date.fromisoformat(s[:10])
    except ValueError:
        return None


def _ts_or_none(s: Optional[str]) -> Optional[_dt.datetime]:
    if not s:
        return None
    try:
        # Frontend sends datetime-local: "2026-05-30T14:00"
        s2 = s.replace("Z", "+00:00")
        return _dt.datetime.fromisoformat(s2)
    except ValueError:
        return None


def _require_admin(user: dict) -> None:
    if user["team"] != "Admin":
        raise HTTPException(403, "Admin only")


def _require_admin_or_tl(user: dict) -> None:
    if user["team"] not in ("Admin", "TL"):
        raise HTTPException(403, "Admin or Team Lead only")


async def _slug_to_id(conn, slug: str):
    row = await conn.fetchrow("SELECT id FROM users WHERE slug = $1", slug)
    return row["id"] if row else None


async def _can_engage_broker(conn, user: dict, broker_id) -> bool:
    """Save-engagement matrix: Admin/TL any CP; KAM/Ground only CPs they own."""
    if user["team"] in ("Admin", "TL"):
        return True
    row = await conn.fetchrow(
        "SELECT owner_user_id FROM v_broker_current_owner WHERE broker_id = $1", broker_id
    )
    return bool(row and row["owner_user_id"] == user["id"])


async def _set_owner(conn, broker_id, owner_id, by_user_id, reason: str) -> None:
    """Close the current cp_assignment and (if owner_id given) open a new one.
    Must run inside a transaction. The gist EXCLUDE constraint is satisfied
    because the closed row ends at now() (exclusive) and the new one starts at now()."""
    await conn.execute(
        "UPDATE cp_assignments SET effective_to = now() "
        "WHERE broker_id = $1 AND effective_to IS NULL",
        broker_id,
    )
    if owner_id:
        await conn.execute(
            "INSERT INTO cp_assignments (broker_id, owner_user_id, assigned_by_user_id, reason) "
            "VALUES ($1, $2, $3, $4)",
            broker_id, owner_id, by_user_id, reason,
        )


async def _set_tier(conn, broker_id, tier: str, by_user_id, reason: str) -> None:
    """Close the current tier_assignment and open a new one. Manual changes carry
    no tier_rank (rank is only meaningful for sheet-sourced T1/T2). Run in a txn."""
    current = await conn.fetchrow(
        "SELECT tier FROM tier_assignments WHERE broker_id = $1 AND effective_to IS NULL",
        broker_id,
    )
    if current and current["tier"] == tier:
        return
    await conn.execute(
        "UPDATE tier_assignments SET effective_to = now() "
        "WHERE broker_id = $1 AND effective_to IS NULL",
        broker_id,
    )
    await conn.execute(
        "INSERT INTO tier_assignments (broker_id, tier, tier_rank, set_by_user_id, reason) "
        "VALUES ($1, $2, NULL, $3, $4)",
        broker_id, tier, by_user_id, reason,
    )


async def _can_edit_visit(conn, user: dict, visit_id) -> bool:
    """Mirror of crm.html's permission helpers, server-side."""
    if user["team"] in ("Admin", "TL"):
        return True
    row = await conn.fetchrow(
        """
        SELECT v.broker_id, v.society_name, v.sales_manager, v.city,
               co.owner_user_id,
               EXISTS (
                 SELECT 1 FROM property_assignments pa
                  JOIN properties p ON p.id = pa.property_id
                  WHERE pa.pm_user_id = $1
                    AND pa.effective_to IS NULL
                    AND p.society_name = v.society_name
               ) AS at_my_property
          FROM visits v
     LEFT JOIN v_broker_current_owner co ON co.broker_id = v.broker_id
         WHERE v.id = $2
        """,
        user["id"], visit_id,
    )
    if not row:
        return False
    if row["owner_user_id"] == user["id"]:
        return True
    # The RM who actually ran the visit can edit it. The visits sheet records some
    # RMs by FIRST name only ("Vinay" vs user "Vinay Kumar"), so match full OR first
    # name — same rule the seed scoping uses to SHOW these visits to the RM.
    sm = (row["sales_manager"] or "").strip()
    nm = (user.get("name") or "").strip()
    if sm and nm and (sm == nm or sm == nm.split(" ", 1)[0]):
        return True
    if user["team"] == "Ground" and row["at_my_property"]:
        return True
    # KAM with admin-granted extra-city access can edit visits in those cities — mirrors
    # the extra-city VISIBILITY grant in scope_for_user. Default off / no cities → no-op.
    if user["team"] == "KAM" and user.get("extra_cities_enabled") \
            and (row["city"] or "") in set(user.get("extra_cities") or []):
        return True
    return False
