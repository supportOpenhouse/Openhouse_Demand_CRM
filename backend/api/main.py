"""FastAPI app. Three concerns:
  1. Auth (Google SSO + signed cookie)
  2. Read: /api/seed returns the snapshot shape crm.html consumes
  3. Write: followups, nudges, notif-read, daily tasks

CORS: credentials allowed from FRONTEND_ORIGIN only.
Cron: /admin/sync hit by Render Cron Job; gated by INTERNAL_CRON_TOKEN.
"""
from __future__ import annotations

import logging
from contextlib import asynccontextmanager
from typing import Optional

from fastapi import Depends, FastAPI, HTTPException, Request, Response, Header
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import RedirectResponse, JSONResponse, PlainTextResponse
from pydantic import BaseModel, Field

from . import auth, config, seed_snapshot, sheet_sync
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


# Local review only (DEV_MODE=1) — log in as any roster user without Google,
# then land on the app. Disabled in production (DEV_MODE unset on Render).
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

    # Serve the frontend from the same origin so cookies + API just work locally.
    import os as _os
    from fastapi.responses import FileResponse
    from fastapi.staticfiles import StaticFiles
    _FE = _os.path.abspath(_os.path.join(_os.path.dirname(__file__), "..", "..", "frontend"))

    @app.get("/")
    async def _dev_index():
        return FileResponse(_os.path.join(_FE, "index.html"))

    @app.get("/openhouse_logo.png")
    async def _dev_logo():
        return FileResponse(_os.path.join(_FE, "openhouse_logo.png"))

    app.mount("/brand", StaticFiles(directory=_os.path.join(_FE, "brand")), name="brand")


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
# Write · followups
# ============================================================================

class FollowupBody(BaseModel):
    visit_code: str = Field(..., description="The sheet 'id' of the visit (e.g. '7820')")
    buyer_status: str = Field(..., description="hot|warm|cold|dead|future_prospect|unc")
    stage: str = Field(..., description="One of STAGES (avfu/revisit_scheduled/...)")
    note: str = Field(..., min_length=1, description="Mandatory free text")
    next_followup_date: Optional[str] = None
    revisit_date: Optional[str] = None


VALID_BUYER_STATUSES = {"hot", "warm", "cold", "dead", "future_prospect", "unc"}
VALID_STAGES = {
    "upcoming", "avfu", "revisit_scheduled", "after_revisit_fu", "negotiation",
    "booking", "ats", "future_prospect", "not_interested", "need_more", "cancelled",
}


@app.post("/api/followups")
async def save_followup(body: FollowupBody, user: dict = Depends(auth.current_user)):
    if body.buyer_status not in VALID_BUYER_STATUSES:
        raise HTTPException(400, f"Invalid buyer_status: {body.buyer_status}")
    if body.stage not in VALID_STAGES:
        raise HTTPException(400, f"Invalid stage: {body.stage}")
    if body.stage == "revisit_scheduled" and not body.revisit_date:
        raise HTTPException(400, "revisit_scheduled requires revisit_date")
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
              next_followup_date, revisit_date, previous_stage, previous_status, source
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'app')
            RETURNING id, created_at
            """,
            visit["id"], user["id"], body.buyer_status, body.stage, body.note.strip(),
            _date_or_none(body.next_followup_date),
            _ts_or_none(body.revisit_date),
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
              support_asked, support_details, remarks, notes
            ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
            RETURNING id, created_at
            """,
            broker["id"], user["id"],
            body.inventory_shared, body.recording_done, body.listing_done,
            (body.listing_link or None), _date_or_none(body.listing_followup_date),
            body.support_asked, (body.support_details or None),
            (body.remarks or None), body.notes.strip(),
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
        SELECT v.broker_id, v.society_name,
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
    if user["team"] == "Ground" and row["at_my_property"]:
        return True
    return False
