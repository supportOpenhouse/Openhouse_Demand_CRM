"""Server-side client for the Open House Core "CP Meetings — Broker Create" API.

Registers channel partners (brokers) in Core. The X-CP-Meetings-Key is a
server-to-server secret and must NEVER reach the browser, so every call here runs
only inside the admin-gated /api/cp-register routes. Ported 1:1 from the Meetings
app's lib/cpMeetingsApi.js so behaviour matches the app exactly:

  GET  /get-cities/                        (key)    -> {cities:[{id,name}]}
  GET  /get-micro-markets-by-city/?city=   (public) -> {microMarkets:[{id,name}]}
  GET  /brokers/last/                      (key)    -> {cpCode:"CP00124"}
  POST /create-broker/                     (key)    -> {cpCode, brokerId, ...}
"""
from __future__ import annotations

import httpx

from . import config


class CpMeetingsError(Exception):
    """Carries the upstream HTTP status + message so the route can map it (Core:
    duplicate phone -> 400, sales_manager_not_found -> 422)."""

    def __init__(self, message: str, status: int = 502, data=None):
        super().__init__(message)
        self.status = status
        self.data = data


def is_configured() -> bool:
    return bool(config.CP_MEETINGS_API_KEY)


def _key_headers(extra: dict | None = None) -> dict:
    h = {"X-CP-Meetings-Key": config.CP_MEETINGS_API_KEY}
    if extra:
        h.update(extra)
    return h


async def get_cities() -> list:
    async with httpx.AsyncClient(timeout=20.0) as client:
        r = await client.get(f"{config.CP_MEETINGS_API_BASE}/get-cities/", headers=_key_headers())
    if r.status_code != 200:
        raise CpMeetingsError(f"get-cities {r.status_code}", 502)
    data = r.json()
    return (data.get("cities") if isinstance(data, dict) else None) or []


async def get_micro_markets_by_city(city: str) -> list:
    async with httpx.AsyncClient(timeout=20.0) as client:
        r = await client.get(
            f"{config.CP_MEETINGS_API_BASE}/get-micro-markets-by-city/", params={"city": city}
        )
    if r.status_code != 200:
        raise CpMeetingsError(f"get-micro-markets {r.status_code}", 502)
    data = r.json()
    return (data.get("microMarkets") if isinstance(data, dict) else None) or []


async def get_next_cp_code() -> str | None:
    async with httpx.AsyncClient(timeout=20.0) as client:
        r = await client.get(f"{config.CP_MEETINGS_API_BASE}/brokers/last/", headers=_key_headers())
    if r.status_code != 200:
        raise CpMeetingsError(f"brokers/last {r.status_code}", 502)
    data = r.json()
    return (data or {}).get("cpCode")


async def create_broker(payload: dict) -> dict:
    async with httpx.AsyncClient(timeout=30.0) as client:
        r = await client.post(
            f"{config.CP_MEETINGS_API_BASE}/create-broker/",
            headers=_key_headers({"Content-Type": "application/json"}),
            json=payload,
        )
    try:
        data = r.json()
    except Exception:  # noqa: BLE001
        data = None
    if r.status_code not in (200, 201):
        msg = (data or {}).get("message") or (data or {}).get("error") or f"create-broker {r.status_code}"
        raise CpMeetingsError(msg, r.status_code, data)
    return data or {}
