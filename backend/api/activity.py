"""Activity log — one line for every action a person or the system takes in the CRM (Akshit, Oct 2026).

What a line holds (table activity_log, migration 024):
  who      actor_user_id / slug / name / team / role   (NULL actor + source='sync' for automation)
  what     action ('visit.followup', 'user.updated', 'export.visits_csv', ...) on object_type/object_id
           with a human object_label ("7820 · Rahul · ROF Ananda") as it read at the time
  change   changes = {"field": {"old": ..., "new": ...}} — full values, nothing truncated
  context  details (anything else worth keeping), ip, user_agent, http_path, at (server time)

Three ways to write a line:

  record(conn, ...)        inside the SAME transaction as the change, so the change and its line are
                           saved together or not at all. Raises on failure (and so rolls the change back).

  record_safe(actor, ...)  for an action that already happened in ANOTHER system (a visit booked in the
                           Openhouse app, a Gmail draft, a sign-in). Own connection; never raises, so a
                           logging hiccup can't turn a completed booking into an error. Failures are logged.

  record_quiet(conn, ...)  for the 15-min sheet sync. Savepoint-protected and never raises: the sync must
                           keep running even if a log line can't be written.

The table refuses UPDATE / DELETE / TRUNCATE (trigger), so lines can only ever be added.
"""
from __future__ import annotations

import contextvars
import datetime as _dt
import decimal
import json
import logging
import math
import uuid
from typing import Any, Optional

from .db import acquire

log = logging.getLogger("api.activity")

# Request context (ip / browser / path / admin "View as"), set by the middleware in main.py per request.
_request_ctx: contextvars.ContextVar[Optional[dict]] = contextvars.ContextVar("activity_request_ctx", default=None)


def bind_request(ip: str, user_agent: str, path: str, view_as: str = "") -> None:
    _request_ctx.set({"ip": (ip or "")[:100], "user_agent": (user_agent or "")[:300],
                      "path": (path or "")[:300], "view_as": (view_as or "").strip()[:80]})


def _clean(s: str) -> str:
    """Postgres text/jsonb refuse NUL and unpaired surrogates — drop them, so an odd character in a note can
    never make the log line (and with it the save) fail."""
    return s.replace("\x00", "").encode("utf-8", "replace").decode("utf-8")


def _jsonable(v: Any) -> Any:
    if isinstance(v, str):
        return _clean(v)
    if isinstance(v, float) and not math.isfinite(v):     # NaN / inf are not valid JSON
        return str(v)
    if isinstance(v, (_dt.datetime, _dt.date, _dt.time)):
        return v.isoformat()
    if isinstance(v, decimal.Decimal):
        return float(v) if v.is_finite() else str(v)
    if isinstance(v, uuid.UUID):
        return str(v)
    if isinstance(v, (list, tuple, set)):
        return [_jsonable(x) for x in v]
    if isinstance(v, dict):
        return {str(k): _jsonable(x) for k, x in v.items()}
    return v


def _blank(v: Any) -> bool:
    return v is None or (isinstance(v, str) and v.strip() == "") or (isinstance(v, (list, dict)) and not v)


def diff(old: Optional[dict], new: Optional[dict], fields: Optional[list] = None) -> dict:
    """{field: {old, new}} for every field whose value changed. None, '' and [] count as the same 'empty'."""
    old, new = dict(old or {}), dict(new or {})
    keys = fields or sorted(set(old) | set(new))
    out = {}
    for k in keys:
        a, b = _jsonable(old.get(k)), _jsonable(new.get(k))
        if _blank(a) and _blank(b):
            continue
        if a != b:
            out[k] = {"old": a, "new": b}
    return out


def _dumps(v: Any) -> Optional[str]:
    return json.dumps(_jsonable(v), default=str, allow_nan=False) if v else None


def _text(v: Any, n: int = 2000) -> Optional[str]:
    return None if v is None else _clean(str(v))[:n]


_INSERT = """
    INSERT INTO activity_log (source, actor_user_id, actor_slug, actor_name, actor_team, actor_role,
                              action, object_type, object_id, object_label, changes, details,
                              ip, user_agent, http_path)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb, $12::jsonb, $13, $14, $15)
"""


def _row(actor: Optional[dict], action: str, object_type=None, object_id=None, object_label=None,
         changes=None, details=None, source: str = "app") -> tuple:
    ctx = _request_ctx.get() or {}
    a = actor or {}
    details = dict(details or {})
    # An admin acting while "viewing as" someone else is still the actor; note who they were viewing as.
    if ctx.get("view_as") and a.get("team") == "Admin" and ctx["view_as"] != a.get("slug"):
        details["viewing_as"] = ctx["view_as"]
    return (source, a.get("id"), a.get("slug"), a.get("name"), a.get("team"), a.get("role"),
            action, object_type, _text(object_id, 300), _text(object_label, 500),
            _dumps(changes), _dumps(details),
            ctx.get("ip") or None, ctx.get("user_agent") or None, ctx.get("path") or None)


async def record(conn, actor: Optional[dict], action: str, *, object_type: Optional[str] = None,
                 object_id: Any = None, object_label: Optional[str] = None, changes: Optional[dict] = None,
                 details: Optional[dict] = None, source: str = "app") -> None:
    """Append one activity line on `conn` (use the caller's transaction). Raises on failure."""
    await conn.execute(_INSERT, *_row(actor, action, object_type, object_id, object_label, changes, details, source))


async def record_many(conn, actor: Optional[dict], lines: list) -> None:
    """Several lines in one round trip (bulk actions). `lines` = dicts of record()'s keyword arguments + action."""
    if lines:
        await conn.executemany(_INSERT, [_row(actor, **ln) for ln in lines])


async def record_safe(actor: Optional[dict], action: str, **kw) -> bool:
    """Log an action already completed elsewhere, on a fresh connection. NEVER raises.
    Returns False (and logs an ERROR) if the line could not be written."""
    try:
        async with acquire() as conn:
            await record(conn, actor, action, **kw)
        return True
    except Exception as e:  # noqa: BLE001
        log.error("ACTIVITY LOG WRITE FAILED action=%s actor=%s object=%s/%s: %s",
                  action, (actor or {}).get("slug"), kw.get("object_type"), kw.get("object_id"), e)
        return False


async def record_quiet(conn, actor: Optional[dict], action: str, **kw) -> bool:
    """Log on `conn` inside a savepoint (or its own transaction). NEVER raises, and a failure here
    can't abort the caller's transaction. For the sheet sync."""
    try:
        async with conn.transaction():
            await record(conn, actor, action, **kw)
        return True
    except Exception as e:  # noqa: BLE001
        log.error("ACTIVITY LOG WRITE FAILED action=%s object=%s/%s: %s",
                  action, kw.get("object_type"), kw.get("object_id"), e)
        return False


# Actions the browser may report itself (POST /api/activity/event) — things that never reach the
# server otherwise: CSV downloads built in the page, snapshot image/text shares, admin "View as".
# Anything not listed here is refused. admin_only = only an Admin can send it.
CLIENT_EVENTS = {
    "export.visits_csv":          {"object_type": "export"},
    "export.analytics_csv":       {"object_type": "export"},
    "export.property_status_csv": {"object_type": "export"},
    "snapshot.image_download":    {"object_type": "export"},
    "snapshot.image_copy":        {"object_type": "export"},
    "snapshot.text_copy":         {"object_type": "export"},
    "snapshot.text_whatsapp":     {"object_type": "export"},
    "snapshot.image_whatsapp":    {"object_type": "export"},
    "view_as.start":              {"object_type": "user", "admin_only": True},
    "view_as.stop":               {"object_type": "user", "admin_only": True},
}
