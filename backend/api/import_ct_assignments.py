"""One-time import of CP ownership + tiers from the CT-assignment Google Sheet.

After this runs, tiers and ownership are CRM-owned: all further changes happen
via the frontend dropdowns (which POST to /api/brokers/{cp}/tier and /owner).
Make sure ENABLE_TIER_SYNC is OFF (default) so the 15-min sheet sync can't roll
these back.

Sources (sheet 1yy4jiSX1uwtb2EVuiMIvBavPoZt2i7Is4WtRyqRIM8w):
  - '10 Broker Tiers (Fresh)'        -> tier (T1..T4) + rank for ALL brokers
  - 'CT08 Master List'               -> T1/T2 owner = 'Assigned Caller' (KAM)
  - '14 T3+T4 CP -> SM Assignment'   -> T3/T4 owner = 'Assigned SM' (Ground)

Owners are stored as names in the sheet and matched to users by normalized name.

Usage (env must be loaded — set -a; source .env; set +a):
    python -m api.import_ct_assignments              # dry-run, writes nothing
    python -m api.import_ct_assignments --commit     # apply the re-map

Idempotent: re-running only changes rows whose tier/owner actually differs.
"""
from __future__ import annotations

import argparse
import asyncio
import os
import re

from . import sheets
from .db import init_pool, close_pool, acquire

SHEET_ID = os.environ.get("SHEET_ID_CT_ASSIGNMENTS", "1yy4jiSX1uwtb2EVuiMIvBavPoZt2i7Is4WtRyqRIM8w")
TAB_TIERS = "10 Broker Tiers (Fresh)"
TAB_T12_OWNERS = "CT08 Master List"
TAB_T34_OWNERS = "14 T3+T4 CP → SM Assignment"
REASON = "ct_sheet_import_2026_06"

# Sheet uses first-names / placeholders for some owners. Map normalized sheet
# name -> roster slug. Anything that still can't be resolved to a roster user
# (e.g. 'Unassigned', 'Hiring 1-3', 'Atishay') is treated as UNASSIGN → queue.
ALIASES = {"udit": "udit"}

_TIER_MAP = {"tier 1": "T1", "tier 2": "T2", "tier 3": "T3", "tier 4": "T4",
             "t1": "T1", "t2": "T2", "t3": "T3", "t4": "T4"}


def _norm_name(s: str) -> str:
    return re.sub(r"\s+", " ", (s or "").strip()).lower()


def _norm_tier(s: str) -> str | None:
    return _TIER_MAP.get((s or "").strip().lower())


def _to_int(s: str):
    s = (s or "").strip()
    try:
        return int(float(s))
    except (TypeError, ValueError):
        return None


def _detail_rows(vals: list[list[str]]) -> tuple[dict, list[list[str]]]:
    """Find the header row containing 'CP Code' (skipping summary blocks) and
    return ({header_name: col_index}, data_rows_below)."""
    for i, row in enumerate(vals):
        if any(str(c).strip().lower() == "cp code" for c in row):
            idx = {str(h).strip(): j for j, h in enumerate(row)}
            return idx, vals[i + 1:]
    raise RuntimeError("No 'CP Code' header row found in tab")


def _cell(row: list[str], idx: dict, name: str) -> str:
    j = idx.get(name)
    if j is None or j >= len(row):
        return ""
    return str(row[j]).strip()


def read_sheet() -> dict:
    """Returns {cp_code: {'tier','rank','owner_name','tier_src','owner_src'}}."""
    sh = sheets.client().open_by_key(SHEET_ID)

    out: dict[str, dict] = {}

    # ---- tiers (all brokers) ----
    idx, rows = _detail_rows(sh.worksheet(TAB_TIERS).get_all_values())
    for r in rows:
        cp = _cell(r, idx, "CP Code")
        if not cp:
            continue
        tier = _norm_tier(_cell(r, idx, "Tier"))
        if not tier:
            continue
        out.setdefault(cp, {})["tier"] = tier
        out[cp]["rank"] = _to_int(_cell(r, idx, "Rank in City"))

    # ---- T1/T2 owners (Assigned Caller) ----
    idx, rows = _detail_rows(sh.worksheet(TAB_T12_OWNERS).get_all_values())
    for r in rows:
        cp = _cell(r, idx, "CP Code")
        if not cp:
            continue
        owner = _cell(r, idx, "Assigned Caller")
        if owner:
            out.setdefault(cp, {})["owner_name"] = owner

    # ---- T3/T4 owners (Assigned SM) ----
    idx, rows = _detail_rows(sh.worksheet(TAB_T34_OWNERS).get_all_values())
    for r in rows:
        cp = _cell(r, idx, "CP Code")
        if not cp:
            continue
        owner = _cell(r, idx, "Assigned SM")
        if owner:
            out.setdefault(cp, {})["owner_name"] = owner

    return out


async def run(commit: bool) -> None:
    plan = read_sheet()
    print(f"Sheet rows parsed: {len(plan)} CPs "
          f"(with tier: {sum(1 for v in plan.values() if v.get('tier'))}, "
          f"with owner: {sum(1 for v in plan.values() if v.get('owner_name'))})")

    await init_pool()
    try:
        async with acquire() as conn:
            users = await conn.fetch("SELECT id, slug, name FROM users")
            name_to_id = {_norm_name(u["name"]): u["id"] for u in users}
            slug_to_id = {u["slug"]: u["id"] for u in users}
            brokers = await conn.fetch("SELECT id, cp_code FROM brokers WHERE deleted_at IS NULL")
            cp_to_id = {b["cp_code"]: b["id"] for b in brokers}

            # current state
            cur_tier = {r["broker_id"]: r["tier"] for r in await conn.fetch(
                "SELECT broker_id, tier FROM tier_assignments WHERE effective_to IS NULL")}
            cur_owner = {r["broker_id"]: r["owner_user_id"] for r in await conn.fetch(
                "SELECT broker_id, owner_user_id FROM cp_assignments WHERE effective_to IS NULL")}

            def resolve_owner(oname: str):
                """sheet owner name -> user id, or None to UNASSIGN (queue)."""
                n = _norm_name(oname)
                if n in ALIASES:
                    return slug_to_id.get(ALIASES[n])
                return name_to_id.get(n)  # None if unmatched -> unassign

            stats = dict(cp_not_in_db=0, tier_changed=0, tier_same=0,
                         owner_changed=0, owner_same=0, owner_unassigned=0, owner_already_none=0)
            unassigned_names: dict[str, int] = {}
            missing_cps: list[str] = []

            tier_ops: list[tuple] = []      # (broker_id, tier, rank)
            owner_ops: list[tuple] = []     # (broker_id, owner_id)  -> close+open
            unassign_ops: list = []         # broker_id              -> close only

            for cp, info in plan.items():
                bid = cp_to_id.get(cp)
                if not bid:
                    stats["cp_not_in_db"] += 1
                    if len(missing_cps) < 25:
                        missing_cps.append(cp)
                    continue

                tier = info.get("tier")
                if tier:
                    if cur_tier.get(bid) == tier:
                        stats["tier_same"] += 1
                    else:
                        stats["tier_changed"] += 1
                        tier_ops.append((bid, tier, info.get("rank")))

                oname = info.get("owner_name")
                if oname:
                    oid = resolve_owner(oname)
                    if oid is None:
                        # unmatched roster name (Unassigned / Hiring / Atishay) -> queue
                        unassigned_names[oname] = unassigned_names.get(oname, 0) + 1
                        if cur_owner.get(bid) is None:
                            stats["owner_already_none"] += 1
                        else:
                            stats["owner_unassigned"] += 1
                            unassign_ops.append(bid)
                    elif cur_owner.get(bid) == oid:
                        stats["owner_same"] += 1
                    else:
                        stats["owner_changed"] += 1
                        owner_ops.append((bid, oid))

            # ---- report ----
            print("\n--- PLAN ---")
            print(f"  brokers in DB                  : {len(cp_to_id)}")
            print(f"  CPs in sheet not in DB         : {stats['cp_not_in_db']}"
                  + (f"  e.g. {missing_cps[:10]}" if missing_cps else ""))
            print(f"  tier   change / unchanged      : {stats['tier_changed']} / {stats['tier_same']}")
            print(f"  owner  reassign / unchanged    : {stats['owner_changed']} / {stats['owner_same']}")
            print(f"  owner  UNASSIGN→queue / already : {stats['owner_unassigned']} / {stats['owner_already_none']}")
            print("  names treated as unassign (→queue):")
            for nm, c in sorted(unassigned_names.items(), key=lambda x: -x[1]):
                print(f"      - {nm!r}: {c}")

            if not commit:
                print("\nDRY RUN — nothing written. Re-run with --commit to apply.")
                return

            print(f"\nCOMMIT — {len(tier_ops)} tier, {len(owner_ops)} reassign, "
                  f"{len(unassign_ops)} unassign…")
            # Batched + set-based so it's seconds, not a 6k-round-trip crawl. Close
            # ALL affected open rows first (one UPDATE each), then bulk-insert the new
            # rows — the gist EXCLUDE holds because every closed row ends at now()
            # (exclusive) before any new row starts at now() (same txn timestamp).
            async with conn.transaction():
                tier_bids = [bid for bid, _, _ in tier_ops]
                owner_reassign_bids = [bid for bid, _ in owner_ops]
                close_owner_bids = owner_reassign_bids + unassign_ops

                if tier_bids:
                    await conn.execute(
                        "UPDATE tier_assignments SET effective_to = now() "
                        "WHERE broker_id = ANY($1::uuid[]) AND effective_to IS NULL", tier_bids)
                    await conn.executemany(
                        "INSERT INTO tier_assignments (broker_id, tier, tier_rank, reason) "
                        "VALUES ($1, $2, $3, $4)",
                        [(bid, tier, rank, REASON) for bid, tier, rank in tier_ops])

                if close_owner_bids:
                    await conn.execute(
                        "UPDATE cp_assignments SET effective_to = now() "
                        "WHERE broker_id = ANY($1::uuid[]) AND effective_to IS NULL", close_owner_bids)
                if owner_ops:
                    await conn.executemany(
                        "INSERT INTO cp_assignments (broker_id, owner_user_id, reason) "
                        "VALUES ($1, $2, $3)",
                        [(bid, oid, REASON) for bid, oid in owner_ops])
            print("DONE — committed.")
    finally:
        await close_pool()


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--commit", action="store_true", help="apply changes (default is dry-run)")
    args = ap.parse_args()
    asyncio.run(run(commit=args.commit))
