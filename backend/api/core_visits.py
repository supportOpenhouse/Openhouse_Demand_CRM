"""Server-side client for the two Core "CRM integration" APIs (staging spec:
docs/crm_staging_api).

  PUT  /schedule-visits/{visit_id}/     complete or cancel a visit from the CRM
  GET  /crm/home-sales-manager/?home_id= read a home's Core SalesManager
  POST /crm/home-sales-manager/          assign / reassign / unassign it

Both reuse the SAME X-CRM-Key already configured for booking
(config.CRM_API_KEY + CRM_BOOKING_API_BASE_URL) — Core confirmed no separate key.
The key is server-to-server and must NEVER reach the browser, so every caller
lives behind a permission-checked route in main.py.

Casing note: the spec documents snake_case request bodies, but Core's serializer
is camelCase and (verified on staging 2026-09-10) accepts EITHER on input while
always REPLYING in camelCase. We send snake_case per the spec and normalise the
response here, so a future Core change to strict camelCase input is a one-line fix
and no caller has to care.
"""
from __future__ import annotations

import logging
from typing import Any, Optional

import httpx

from . import config

log = logging.getLogger("core_visits")

# Core's own vocabulary (docs/crm_staging_api). Validated before we call out, so a
# bad value is a CRM 400 rather than an opaque Core 400.
VALID_LEAD_STATUSES = {"hot", "warm", "cold", "future_prospect", "dead", "select_status"}
VALID_UPDATE_STATUSES = {"completed", "cancelled"}

# The six structured fields of the assisted-visit form. Free-text is allowed (Core
# does not enum-validate them), so we pass through whatever the UI sends but drop
# unknown keys — that keeps a UI typo from silently becoming a Core field.
SM_FEEDBACK_FIELDS = (
    "time_spent_on_site",
    "society_amenity_tour",
    "price_discussion",
    "client_queries",
    "closing_signal",
    "buyer_primary_concern",
)


class CoreVisitError(Exception):
    """Carries the upstream HTTP status + message so the route can map it
    (404 visit/home not found, 422 sales_manager_not_found/inactive, 400 validation)."""

    def __init__(self, message: str, status: int = 502, data: Any = None):
        super().__init__(message)
        self.status = status
        self.data = data


def is_configured() -> bool:
    return bool(config.CRM_BOOKING_API_BASE_URL and config.CRM_API_KEY)


def _headers() -> dict:
    return {"X-CRM-Key": config.CRM_API_KEY, "Content-Type": "application/json"}


def _base() -> str:
    return config.CRM_BOOKING_API_BASE_URL


def _err_message(payload: Any, fallback: str) -> str:
    """Pull a human message out of Core's error shapes: {"error": "..."},
    {"detail": "..."} or DRF field errors {"selectedDate": ["This field is required."]}."""
    if isinstance(payload, dict):
        for key in ("error", "detail"):
            v = payload.get(key)
            if isinstance(v, str) and v:
                return v
        bits = []
        for k, v in payload.items():
            if isinstance(v, list) and v:
                bits.append(f"{k}: {v[0]}")
            elif isinstance(v, str):
                bits.append(f"{k}: {v}")
        if bits:
            return "; ".join(bits[:4])
    if isinstance(payload, str) and payload:
        return payload[:300]
    return fallback


def _parse(resp: httpx.Response) -> Any:
    try:
        return resp.json()
    except Exception:  # noqa: BLE001 — Core can return an HTML error page
        return resp.text


def _raise_for_status(resp: httpx.Response, what: str) -> Any:
    data = _parse(resp)
    if resp.status_code >= 400:
        raise CoreVisitError(_err_message(data, f"{what} failed (HTTP {resp.status_code})"),
                             status=resp.status_code, data=data)
    return data


def _norm_sales_manager(sm: Any) -> Optional[dict]:
    """camelCase → snake_case for the SalesManager block, so the CRM frontend and
    DB speak one shape regardless of Core's renderer."""
    if not isinstance(sm, dict):
        return None
    return {
        "id": sm.get("id"),
        "name": sm.get("name") or "",
        "mobile": sm.get("mobile") or sm.get("mobileNumber") or "",
        "city_id": sm.get("city_id", sm.get("cityId")),
        "is_active": sm.get("is_active", sm.get("isActive")),
    }


def _norm_visit(v: Any) -> dict:
    """camelCase visit → the snake_case subset the CRM cares about. Unknown/extra
    Core fields are dropped deliberately: this is a confirmation payload, not a mirror."""
    if not isinstance(v, dict):
        return {}
    return {
        "id": v.get("id"),
        "status": v.get("status"),
        "platform": v.get("platform"),
        "lead_status": v.get("lead_status", v.get("leadStatus")),
        "sales_feedback": v.get("sales_feedback", v.get("salesFeedback")),
        "selected_date": v.get("selected_date", v.get("selectedDate")),
        "selected_time": v.get("selected_time", v.get("selectedTime")),
        "visit_uuid": v.get("visit_uuid", v.get("visitUuid")),
        "home": v.get("home"),
        "buyer": v.get("buyer"),
        "broker": v.get("broker"),
    }


# ============================================================================
# 1. Visit complete / cancel
# ============================================================================

async def update_visit(
    visit_id: str | int,
    *,
    selected_date: str,
    selected_time: str,
    status: str,
    lead_status: Optional[str] = None,
    sales_feedback: Optional[str] = None,
    sm_demand_feedback: Optional[dict] = None,
) -> dict:
    """PUT /schedule-visits/{visit_id}/.

    Core infers the completion path from the payload (same rule as the app):
      * `sm_demand_feedback` present  → ASSISTED complete (structured form)
      * otherwise                     → OTP complete (sales_feedback only)
    `selected_date` + `selected_time` are ALWAYS required by Core, even on cancel —
    they must be the visit's CURRENT stored values, which the caller reads from the
    CRM's own `visits` row.
    """
    if status not in VALID_UPDATE_STATUSES:
        raise CoreVisitError(f"status must be one of {sorted(VALID_UPDATE_STATUSES)}", status=400)
    if not selected_date or not selected_time:
        raise CoreVisitError("selected_date and selected_time are required by Core", status=400)
    if lead_status and lead_status not in VALID_LEAD_STATUSES:
        raise CoreVisitError(f"lead_status must be one of {sorted(VALID_LEAD_STATUSES)}", status=400)

    payload: dict = {
        "selected_date": selected_date,
        "selected_time": selected_time,
        "status": status,
    }
    # Cancels carry no feedback — Core only reads it on the completed path, and
    # sending it would put stray notes on a cancelled visit.
    if status == "completed":
        if sales_feedback:
            payload["sales_feedback"] = sales_feedback
        if lead_status:
            payload["lead_status"] = lead_status
        if sm_demand_feedback:
            trimmed = {k: v for k, v in sm_demand_feedback.items()
                       if k in SM_FEEDBACK_FIELDS and str(v or "").strip()}
            if trimmed:
                payload["sm_demand_feedback"] = trimmed

    url = f"{_base()}/schedule-visits/{visit_id}/"
    log.info("[core-visit] PUT visit=%s status=%s assisted=%s",
             visit_id, status, "sm_demand_feedback" in payload)
    async with httpx.AsyncClient(timeout=30.0, headers=_headers()) as client:
        resp = await client.put(url, json=payload)
    data = _raise_for_status(resp, "visit update")
    out = _norm_visit(data)
    log.info("[core-visit] OK visit=%s -> status=%s platform=%s",
             visit_id, out.get("status"), out.get("platform"))
    return out


# ============================================================================
# 2. Home sales manager
# ============================================================================

async def get_home_sales_manager(home_id: str | int) -> dict:
    """GET /crm/home-sales-manager/?home_id=… → {home_id, sales_manager|None}."""
    url = f"{_base()}/crm/home-sales-manager/"
    async with httpx.AsyncClient(timeout=20.0, headers=_headers()) as client:
        resp = await client.get(url, params={"home_id": str(home_id)})
    data = _raise_for_status(resp, "home sales-manager fetch")
    return {
        "home_id": data.get("home_id", data.get("homeId")),
        "sales_manager": _norm_sales_manager(data.get("sales_manager", data.get("salesManager"))),
    }


async def set_home_sales_manager(home_id: str | int, sales_manager_id: Optional[int]) -> dict:
    """POST /crm/home-sales-manager/ — assign, reassign, or unassign (None → null).

    The `sales_manager_id` KEY must always be present in the body; `None` is the
    documented unassign signal, so it is NOT omitted when falsy.
    """
    url = f"{_base()}/crm/home-sales-manager/"
    payload = {"home_id": int(home_id) if str(home_id).isdigit() else home_id,
               "sales_manager_id": sales_manager_id}
    log.info("[core-visit] POST home-sm home=%s -> sm=%s", home_id, sales_manager_id)
    async with httpx.AsyncClient(timeout=20.0, headers=_headers()) as client:
        resp = await client.post(url, json=payload)
    data = _raise_for_status(resp, "home sales-manager update")
    return {
        "home_id": data.get("home_id", data.get("homeId")),
        "previous_sales_manager_id": data.get("previous_sales_manager_id",
                                              data.get("previousSalesManagerId")),
        "sales_manager": _norm_sales_manager(data.get("sales_manager", data.get("salesManager"))),
    }
