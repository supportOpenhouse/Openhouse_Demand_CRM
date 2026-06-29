"""Meeting-recordings sync — a READ-ONLY annotation layer.

Reads the Openhouse Meetings app DB (config.MEETINGS_DATABASE_URL) STRICTLY
READ-ONLY (a `readonly` transaction + SELECT-only) and upserts a glanceable
"🎙 meeting recorded" record (date + who conducted it + the structured summary)
into the CRM's own `meeting_recordings` table.

It writes to NOTHING except `meeting_recordings`. It never touches followups,
visits, brokers, engagements, buyers, users or any existing row — so it cannot
change a lead, a pipeline stage, a note or a metric. With MEETINGS_DATABASE_URL
unset it is a no-op.

Matching (each recording, in priority order; broker-level per the agreed design):
  1. cp_code     -> a real brokers.cp_code            (broker anchor)
  2. cp_mobile   -> a broker phone, ONLY if that last-10 maps to exactly ONE
                    broker (unambiguous; never guesses)
  3. cp_visit_id -> a real visits.visit_code          (the per-follow-up anchor;
                    only ~14 recordings carry one)
A row is 'matched' if it resolved a broker and/or a visit, else 'unmatched'
(the admin match-queue). A human 'manual' match is preserved across every run.
"""
from __future__ import annotations

import json
import logging
import re

import asyncpg

from . import config

log = logging.getLogger("meetings_sync")

_MEETING_TYPES = ("engagement", "visit")


def _strip_channel_binding(dsn: str) -> str:
    # asyncpg doesn't accept the libpq `channel_binding` parameter; Neon adds it.
    return re.sub(r"[?&]channel_binding=[^&]*", "", dsn or "")


def _last10(s) -> str:
    d = "".join(ch for ch in (s or "") if ch.isdigit())
    return d[-10:] if len(d) >= 10 else ""


def _norm(s) -> str:
    return re.sub(r"\s+", " ", (s or "").strip().lower())


def _rm_match(sales_manager, rm_name) -> bool:
    """Same RM? Full normalized name, or first-name fallback (names drift in spelling)."""
    a, b = _norm(sales_manager), _norm(rm_name)
    if not a or not b:
        return False
    return a == b or a.split(" ")[0] == b.split(" ")[0]


def _as_jsonb(v):
    if v is None or isinstance(v, str):
        return v
    return json.dumps(v)


async def _read_meetings() -> list:
    """SELECT-only read of the external Meetings DB inside a read-only transaction."""
    dsn = _strip_channel_binding(config.MEETINGS_DATABASE_URL)
    conn = await asyncpg.connect(dsn, timeout=15, statement_cache_size=0)
    try:
        async with conn.transaction(readonly=True):
            return await conn.fetch(
                """
                SELECT m.id, m.meeting_type, m.started_at, m.status,
                       (m.started_at AT TIME ZONE 'Asia/Kolkata')::date AS ist_date,
                       m.cp_code, m.cp_name, m.cp_mobile,
                       NULLIF(btrim(m.cp_visit_id::text), '') AS cp_visit_id,
                       u.name AS rm_name, u.smid AS rm_smid,
                       m.summary
                FROM meetings m
                LEFT JOIN users u ON u.id = m.rm_id
                WHERE m.status = 'ready'
                  AND m.meeting_type = ANY($1::text[])
                """,
                list(_MEETING_TYPES),
            )
    finally:
        await conn.close()


_UPSERT = """
    INSERT INTO meeting_recordings (
      meeting_id, meeting_type, meeting_date, rm_name, rm_smid,
      cp_code, cp_name, cp_mobile, cp_visit_id,
      broker_cp_code, visit_code, match_status, match_method, summary, status,
      synced_at, created_at, updated_at
    ) VALUES (
      $1,$2,$3,$4,$5, $6,$7,$8,$9, $10,$11,$12,$13,$14::jsonb,$15, now(), now(), now()
    )
    ON CONFLICT (meeting_id) DO UPDATE SET
      meeting_type = EXCLUDED.meeting_type,
      meeting_date = EXCLUDED.meeting_date,
      rm_name      = EXCLUDED.rm_name,
      rm_smid      = EXCLUDED.rm_smid,
      cp_code      = EXCLUDED.cp_code,
      cp_name      = EXCLUDED.cp_name,
      cp_mobile    = EXCLUDED.cp_mobile,
      cp_visit_id  = EXCLUDED.cp_visit_id,
      summary      = EXCLUDED.summary,
      status       = EXCLUDED.status,
      -- preserve a human's decision forever (manual match OR dismissed); otherwise
      -- refresh from the auto-resolver.
      broker_cp_code = CASE WHEN meeting_recordings.match_status IN ('manual','dismissed')
                            THEN meeting_recordings.broker_cp_code ELSE EXCLUDED.broker_cp_code END,
      visit_code     = CASE WHEN meeting_recordings.match_status IN ('manual','dismissed')
                            THEN meeting_recordings.visit_code     ELSE EXCLUDED.visit_code END,
      match_status   = CASE WHEN meeting_recordings.match_status IN ('manual','dismissed')
                            THEN meeting_recordings.match_status   ELSE EXCLUDED.match_status END,
      match_method   = CASE WHEN meeting_recordings.match_status IN ('manual','dismissed')
                            THEN meeting_recordings.match_method   ELSE EXCLUDED.match_method END,
      synced_at    = now(),
      updated_at   = now()
"""


async def run_sync(crm_conn: asyncpg.Connection) -> dict:
    """Refresh meeting_recordings from the Meetings DB. Returns a summary dict.
    `crm_conn` is a CRM-DB connection; all writes go ONLY to meeting_recordings."""
    if not config.MEETINGS_DATABASE_URL:
        return {"skipped": "MEETINGS_DATABASE_URL unset"}

    try:
        rows = await _read_meetings()
    except Exception as e:  # noqa: BLE001 — a bad external DB must never break the CRM sync
        log.warning("meetings run_sync: read failed: %s", e)
        return {"error": str(e)[:200], "seen": 0, "upserted": 0, "matched": 0, "unmatched": 0}

    # CRM resolution maps (read from our own DB).
    broker_codes = {r["cp_code"] for r in await crm_conn.fetch(
        "SELECT cp_code FROM brokers WHERE deleted_at IS NULL AND COALESCE(cp_code,'') <> ''")}
    visit_rows = await crm_conn.fetch(
        "SELECT visit_code, cp_code, visit_date, sales_manager FROM visits "
        "WHERE COALESCE(visit_code::text,'') <> ''")
    visit_codes = {str(r["visit_code"]) for r in visit_rows}
    # (cp_code, visit_date) -> [(visit_code, sales_manager), ...] for same-day inference
    visits_by_cp_day: dict = {}
    for r in visit_rows:
        if r["cp_code"] and r["visit_date"]:
            visits_by_cp_day.setdefault((r["cp_code"], r["visit_date"]), []).append(
                (str(r["visit_code"]), r["sales_manager"]))
    # unambiguous phone -> cp_code (only phones owned by exactly one broker)
    phone_count: dict = {}
    phone_cp: dict = {}
    for r in await crm_conn.fetch(
        "SELECT cp_code, phone, alt_phone FROM brokers "
        "WHERE deleted_at IS NULL AND COALESCE(cp_code,'') <> ''"):
        for ph in (_last10(r["phone"]), _last10(r["alt_phone"])):
            if not ph:
                continue
            phone_count[ph] = phone_count.get(ph, 0) + 1
            phone_cp[ph] = r["cp_code"]
    phone_unique = {ph: cp for ph, cp in phone_cp.items() if phone_count.get(ph) == 1}

    payload: list = []
    seen = matched = 0
    cnt = {"cp_code": 0, "cp_mobile": 0, "visit_exact": 0, "visit_sameday": 0, "visit_sameday_rm": 0}
    for r in rows:
        seen += 1
        cp_code = r["cp_code"] or None
        cp_visit_id = r["cp_visit_id"] or None

        # --- broker anchor: cp_code, else an unambiguous phone match ---
        broker_cp = cp_code if (cp_code and cp_code in broker_codes) else None
        broker_method = "cp_code" if broker_cp else None
        if not broker_cp:
            ph = _last10(r["cp_mobile"])
            if ph and ph in phone_unique:
                broker_cp, broker_method = phone_unique[ph], "cp_mobile"

        # --- visit anchor: exact id, else HIGH-CONFIDENCE same-day inference.
        #     Only ever pins when the answer is UNIQUE (one visit that day for the
        #     broker; or, if several, exactly one conducted by the same RM). The
        #     recordings carry no buyer/society, so RM is the only tiebreaker. ---
        v_code = cp_visit_id if (cp_visit_id and cp_visit_id in visit_codes) else None
        visit_method = "cp_visit_id" if v_code else None
        if not v_code and r["meeting_type"] == "visit" and cp_code and r["ist_date"]:
            cands = visits_by_cp_day.get((cp_code, r["ist_date"]), [])
            if len(cands) == 1:                                  # broker had ONE visit that day
                v_code, visit_method = cands[0][0], "sameday"
            elif len(cands) >= 2:                                # tiebreak on the conducting RM
                rmc = [vc for vc in cands if _rm_match(vc[1], r["rm_name"])]
                if len(rmc) == 1:
                    v_code, visit_method = rmc[0][0], "sameday_rm"

        if broker_method == "cp_code":   cnt["cp_code"] += 1
        elif broker_method == "cp_mobile": cnt["cp_mobile"] += 1
        if visit_method == "cp_visit_id":  cnt["visit_exact"] += 1
        elif visit_method == "sameday":    cnt["visit_sameday"] += 1
        elif visit_method == "sameday_rm": cnt["visit_sameday_rm"] += 1

        parts = [p for p in (broker_method, visit_method) if p]
        match_method = "+".join(parts) if parts else None
        status = "matched" if (broker_cp or v_code) else "unmatched"
        if status == "matched":
            matched += 1
        payload.append((
            r["id"], r["meeting_type"], r["started_at"], r["rm_name"], r["rm_smid"],
            cp_code, r["cp_name"], r["cp_mobile"], cp_visit_id,
            broker_cp, v_code, status, match_method, _as_jsonb(r["summary"]), r["status"],
        ))

    CHUNK = 500
    for i in range(0, len(payload), CHUNK):
        await crm_conn.executemany(_UPSERT, payload[i:i + CHUNK])

    out = {"seen": seen, "upserted": seen, "matched": matched, "unmatched": seen - matched,
           "broker_by_cp_code": cnt["cp_code"], "broker_by_phone": cnt["cp_mobile"],
           "visit_exact_id": cnt["visit_exact"], "visit_sameday_unique": cnt["visit_sameday"],
           "visit_sameday_rm": cnt["visit_sameday_rm"]}
    log.info("[meetings] run_sync: %s", out)
    return out
