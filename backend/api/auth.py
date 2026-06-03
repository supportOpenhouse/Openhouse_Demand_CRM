"""Google OAuth login + signed session cookie.

Flow:
  Frontend → /auth/google/start  → Google consent → /auth/google/callback
  Callback: verify ID token, check @openhouse.in, upsert user row, set cookie,
  redirect back to FRONTEND_ORIGIN.

Permissions matrix is enforced per-route in main.py via the resolved user.
"""
from __future__ import annotations

import secrets
import urllib.parse
import json
from typing import Optional

import httpx
from fastapi import Request, Response, HTTPException, Depends
from itsdangerous import URLSafeTimedSerializer, BadSignature, SignatureExpired

from . import config
from .db import acquire


_signer = URLSafeTimedSerializer(config.SESSION_SECRET, salt="oh-crm-session")
_state_signer = URLSafeTimedSerializer(config.SESSION_SECRET, salt="oh-crm-oauth-state")

GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth"
GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token"
GOOGLE_USERINFO_URL = "https://openidconnect.googleapis.com/v1/userinfo"


def _redirect_uri() -> str:
    return f"{config.API_BASE_URL}/auth/google/callback"


def build_login_url(next_url: Optional[str]) -> str:
    state = _state_signer.dumps({"next": next_url or config.FRONTEND_ORIGIN, "n": secrets.token_urlsafe(8)})
    params = {
        "client_id": config.GOOGLE_OAUTH_CLIENT_ID,
        "response_type": "code",
        "scope": "openid email profile",
        "redirect_uri": _redirect_uri(),
        "access_type": "online",
        "include_granted_scopes": "true",
        "prompt": "select_account",
        "hd": config.ALLOWED_EMAIL_DOMAIN,
        "state": state,
    }
    return f"{GOOGLE_AUTH_URL}?{urllib.parse.urlencode(params)}"


async def exchange_code_for_userinfo(code: str) -> dict:
    async with httpx.AsyncClient(timeout=15.0) as client:
        token_resp = await client.post(
            GOOGLE_TOKEN_URL,
            data={
                "code": code,
                "client_id": config.GOOGLE_OAUTH_CLIENT_ID,
                "client_secret": config.GOOGLE_OAUTH_CLIENT_SECRET,
                "redirect_uri": _redirect_uri(),
                "grant_type": "authorization_code",
            },
        )
        if token_resp.status_code != 200:
            # Surface Google's error description verbatim so we don't have to dig in logs.
            try:
                body = token_resp.json()
                err = body.get("error", "unknown")
                desc = body.get("error_description", "")
            except Exception:
                err, desc = "non_json_response", token_resp.text[:200]
            raise HTTPException(
                400,
                f"Google token exchange failed ({token_resp.status_code} {err}): {desc} · "
                f"Most common causes: wrong GOOGLE_OAUTH_CLIENT_SECRET on Render; "
                f"redirect_uri '{_redirect_uri()}' not registered in Google Cloud Console; "
                f"or the auth code expired (re-try login).",
            )
        access_token = token_resp.json().get("access_token")
        if not access_token:
            raise HTTPException(400, "Token exchange returned no access_token")
        info_resp = await client.get(
            GOOGLE_USERINFO_URL, headers={"Authorization": f"Bearer {access_token}"}
        )
        if info_resp.status_code != 200:
            raise HTTPException(
                400,
                f"Google userinfo fetch failed: {info_resp.status_code} {info_resp.text[:200]}",
            )
        return info_resp.json()


def set_session_cookie(response: Response, user_id: str, email: str, slug: str) -> None:
    token = _signer.dumps({"uid": user_id, "email": email, "slug": slug})
    response.set_cookie(
        key=config.SESSION_COOKIE_NAME,
        value=token,
        max_age=config.SESSION_MAX_AGE_SECONDS,
        httponly=True,
        secure=not config.DEV_MODE,  # http://localhost can't store Secure cookies
        samesite="lax",  # first-party: API is proxied under the vercel.app origin (see vercel.json)
        path="/",
    )


def clear_session_cookie(response: Response) -> None:
    response.delete_cookie(config.SESSION_COOKIE_NAME, path="/", samesite="lax", secure=not config.DEV_MODE)


def _read_state(state: str) -> dict:
    try:
        return _state_signer.loads(state, max_age=600)
    except (BadSignature, SignatureExpired):
        raise HTTPException(400, "Invalid or expired OAuth state")


def _read_session(request: Request) -> Optional[dict]:
    token = request.cookies.get(config.SESSION_COOKIE_NAME)
    if not token:
        return None
    try:
        return _signer.loads(token, max_age=config.SESSION_MAX_AGE_SECONDS)
    except (BadSignature, SignatureExpired):
        return None


async def current_user(request: Request) -> dict:
    sess = _read_session(request)
    if not sess:
        raise HTTPException(401, "Not signed in")
    async with acquire() as conn:
        row = await conn.fetchrow(
            "SELECT id, slug, email, name, team, role, cities, active "
            "FROM users WHERE id = $1 AND active = true",
            sess["uid"],
        )
    if not row:
        raise HTTPException(401, "User not found or inactive")
    return dict(row)


async def current_user_or_none(request: Request) -> Optional[dict]:
    try:
        return await current_user(request)
    except HTTPException:
        return None


async def upsert_user_for_login(email: str, name: str, picture: Optional[str]) -> dict:
    """Look up the user by email. We do NOT auto-create new users on first login —
    the team roster is managed via bootstrap.py / admin UI. If the email isn't in
    the users table, login is refused.
    """
    async with acquire() as conn:
        row = await conn.fetchrow(
            "SELECT id, slug, email, name, team, role, cities, active "
            "FROM users WHERE lower(email) = lower($1)",
            email,
        )
        if not row:
            raise HTTPException(
                403,
                f"{email} is not on the demand team roster. Ask an admin to add you, "
                f"then sign in again.",
            )
        if not row["active"]:
            raise HTTPException(403, "Your account is inactive. Contact an admin.")
        if picture:
            await conn.execute(
                "UPDATE users SET avatar_url = $1, updated_at = now() WHERE id = $2",
                picture,
                row["id"],
            )
        return dict(row)


def require_team(*allowed_teams: str):
    """Dependency factory: 403 unless user's team is in allowed_teams."""

    async def _dep(user: dict = Depends(current_user)) -> dict:
        if user["team"] not in allowed_teams:
            raise HTTPException(403, f"Requires team in {allowed_teams}")
        return user

    return _dep


def require_admin(user: dict = Depends(current_user)) -> dict:
    if user["team"] != "Admin":
        raise HTTPException(403, "Admin only")
    return user
