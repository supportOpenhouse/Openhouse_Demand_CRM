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
