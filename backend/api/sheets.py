"""Google Sheets read access. Lazy-init the gspread client from either
GOOGLE_SERVICE_ACCOUNT_JSON (inline) or a file at GOOGLE_APPLICATION_CREDENTIALS_PATH."""
from __future__ import annotations

import json

import gspread
from google.oauth2.service_account import Credentials

from . import config

_SCOPES = ["https://www.googleapis.com/auth/spreadsheets.readonly"]
_client: gspread.Client | None = None


def _credentials() -> Credentials:
    if config.GOOGLE_SERVICE_ACCOUNT_JSON:
        info = json.loads(config.GOOGLE_SERVICE_ACCOUNT_JSON)
        return Credentials.from_service_account_info(info, scopes=_SCOPES)
    if config.GOOGLE_APPLICATION_CREDENTIALS_PATH:
        return Credentials.from_service_account_file(
            config.GOOGLE_APPLICATION_CREDENTIALS_PATH, scopes=_SCOPES
        )
    raise RuntimeError(
        "No Google service-account credentials. Set GOOGLE_SERVICE_ACCOUNT_JSON or "
        "GOOGLE_APPLICATION_CREDENTIALS_PATH."
    )


def client() -> gspread.Client:
    global _client
    if _client is None:
        _client = gspread.authorize(_credentials())
    return _client


def read_tab(sheet_id: str, tab: str) -> list[list[str]]:
    sh = client().open_by_key(sheet_id)
    ws = sh.worksheet(tab)
    return ws.get_all_values()
