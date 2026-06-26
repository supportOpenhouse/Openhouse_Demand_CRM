"""One-shot bootstrap: schema → users → initial sheet sync → derive CP owners.

Run once after creating the Neon project:

    python -m api.bootstrap

Idempotent. Safe to re-run; uses ON CONFLICT and existence checks throughout.
"""
from __future__ import annotations

import asyncio
import json
import logging
from collections import defaultdict
from pathlib import Path

from . import config, sheet_sync
from .db import init_pool, close_pool, acquire

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(name)s %(levelname)s %(message)s")
log = logging.getLogger("bootstrap")


# Frozen team roster (matches USERS array in crm.html). Source of truth for v1.
USERS: list[dict] = [
    # Admin
    {"slug": "akshit",   "email": "akshit@openhouse.in",         "name": "Akshit Chaudhary", "role": "admin",     "team": "Admin",  "cities": ["Gurgaon", "Noida", "Ghaziabad"]},
    {"slug": "ankit",    "email": "ankit@openhouse.in",          "name": "Ankit Khemka",     "role": "admin",     "team": "Admin",  "cities": ["Gurgaon", "Noida", "Ghaziabad"]},
    {"slug": "saransh",  "email": "saransh.khera@openhouse.in",  "name": "Saransh Khera",    "role": "admin",     "team": "Admin",  "cities": ["Gurgaon", "Noida", "Ghaziabad"]},
    # TL
    {"slug": "manish",   "email": "manish.pal@openhouse.in",     "name": "Manish Pal",       "role": "tl_head",   "team": "TL",     "cities": ["Gurgaon", "Noida", "Ghaziabad"]},
    {"slug": "rajnish",  "email": "rajnish@openhouse.in",        "name": "Rajnish",          "role": "tl_head",   "team": "TL",     "cities": ["Gurgaon", "Noida", "Ghaziabad"]},
    {"slug": "puran",    "email": "puran.kiraula@openhouse.in",  "name": "Puran Kiraula",    "role": "tl_closer", "team": "TL",     "cities": ["Gurgaon"]},
    {"slug": "ajitesh",  "email": "ajitesh.singh@openhouse.in",  "name": "Ajitesh Singh",    "role": "tl_closer", "team": "TL",     "cities": ["Noida"]},
    # KAM
    {"slug": "adiksha",  "email": "adiksha.sahu@openhouse.in",   "name": "Adiksha Sahu",     "role": "kam_tl",    "team": "KAM",    "cities": ["Gurgaon", "Noida", "Ghaziabad"]},
    {"slug": "shubham",  "email": "shubham.sharma@openhouse.in", "name": "Shubham Sharma",   "role": "kam",       "team": "KAM",    "cities": ["Gurgaon"]},
    {"slug": "aman",     "email": "aman.rawat@openhouse.in",     "name": "Aman Rawat",       "role": "kam",       "team": "KAM",    "cities": ["Gurgaon"]},
    {"slug": "mukul",    "email": "mukul.chhabra@openhouse.in",  "name": "Mukul Chhabra",    "role": "kam",       "team": "KAM",    "cities": ["Noida"]},
    {"slug": "mayank",   "email": "mayank.chauhan@openhouse.in", "name": "Mayank Chauhan",   "role": "kam",       "team": "KAM",    "cities": ["Noida"]},
    {"slug": "saket",    "email": "saket.kumar@openhouse.in",    "name": "Saket Kumar",      "role": "kam",       "team": "KAM",    "cities": ["Ghaziabad"]},
    # Ground
    {"slug": "abhash",   "email": "abhash.kumar@openhouse.in",   "name": "Abhash Kumar",    "role": "ground", "team": "Ground", "cities": ["Noida"]},
    {"slug": "sahil",    "email": "sahil.kumar@openhouse.in",    "name": "Sahil Kumar",     "role": "ground", "team": "Ground", "cities": ["Ghaziabad"]},
    {"slug": "vinay",    "email": "vinay.kumar@openhouse.in",    "name": "Vinay Kumar",     "role": "ground", "team": "Ground", "cities": ["Noida"]},
    {"slug": "joginder", "email": "joginder.singh@openhouse.in", "name": "Joginder Singh",  "role": "ground", "team": "Ground", "cities": ["Gurgaon"]},
    {"slug": "aditya",   "email": "aditya.bhasker@openhouse.in", "name": "Aditya Bhasker",  "role": "ground", "team": "Ground", "cities": ["Gurgaon"]},
    {"slug": "ankitkr",  "email": "ankit.kumar@openhouse.in",    "name": "Ankit Kumar",     "role": "ground", "team": "Ground", "cities": ["Gurgaon"]},
    {"slug": "vipul",    "email": "vipul.suneja@openhouse.in",   "name": "Vipul Suneja",    "role": "ground", "team": "Ground", "cities": ["Noida"]},
    {"slug": "ashwani",  "email": "ashwani.sharma@openhouse.in", "name": "Ashwani Sharma",  "role": "ground", "team": "Ground", "cities": ["Gurgaon"]},
    {"slug": "hashim",   "email": "hashim@openhouse.in",         "name": "Hashim",          "role": "ground", "team": "Ground", "cities": ["Ghaziabad"]},
    {"slug": "harsh",    "email": "harsh.arora@openhouse.in",    "name": "Harsh Arora",     "role": "ground", "team": "Ground", "cities": ["Gurgaon"]},
    {"slug": "ankitg",   "email": "ankit.gupta@openhouse.in",    "name": "Ankit Gupta",     "role": "ground", "team": "Ground", "cities": ["Gurgaon"]},
    {"slug": "udit",     "email": "udit.gangwar@openhouse.in",   "name": "Udit Gangwar",    "role": "ground", "team": "Ground", "cities": ["Gurgaon"]},
    # Report (view-only) — supply-team members with access to the Report Share feature
    # ONLY. team="Report" grants no other CRM access (see seed_snapshot.scope_for_user
    # and _require_report_access). cities is unused for this team (scope is global).
    {"slug": "shashank", "email": "shashank.kumar@openhouse.in", "name": "Shashank Kumar", "role": "report_viewer", "team": "Report", "cities": []},
    {"slug": "rupali",   "email": "rupali.prasad@openhouse.in",  "name": "Rupali Prasad",   "role": "report_viewer", "team": "Report", "cities": []},
    {"slug": "abhishekr","email": "abhishek.rathore@openhouse.in","name": "Abhishek Rathore","role": "report_viewer", "team": "Report", "cities": []},  # 'abhishek' slug already taken by Abhishek Dwivedi (Ground)
    {"slug": "animesh",  "email": "animesh.singh@openhouse.in",  "name": "Animesh Singh",   "role": "report_viewer", "team": "Report", "cities": []},
    {"slug": "khushi",   "email": "khushi.sharma@openhouse.in",  "name": "Khushi Sharma",   "role": "report_viewer", "team": "Report", "cities": []},
]

KAM_BUCKETS = {
    "Gurgaon":   ["shubham", "aman"],
    "Noida":     ["mukul", "mayank"],
    "Ghaziabad": ["saket"],
}
GROUND_BUCKETS = {
    "Gurgaon":   ["joginder", "aditya", "ankitkr", "ashwani", "harsh", "ankitg", "udit"],
    "Noida":     ["abhash", "vinay", "vipul"],
    "Ghaziabad": ["sahil", "hashim"],
}

WA_TEMPLATES = [
    {"id": "blank",            "label": "Open WhatsApp",                "order": 1, "body": ""},
    {"id": "weekly_summary",   "label": "7-day visit summary",          "order": 2, "body": ""},
    {"id": "open_pipeline",    "label": "Open buyers pipeline",         "order": 3, "body": ""},
    {"id": "inv_city",         "label": "Live inventory · {CP city}",   "order": 4, "body": ""},
    {"id": "inv_no_gz",        "label": "Live inventory · Noida + GZ",  "order": 5, "body": ""},
]


async def run_schema() -> None:
    sql_path = config.MIGRATIONS_DIR / "001_initial_schema.sql"
    if not sql_path.exists():
        raise RuntimeError(f"Migration not found: {sql_path}")
    sql = sql_path.read_text()
    log.info("applying schema migration (%d KB)", len(sql) // 1024)
    async with acquire() as conn:
        await conn.execute(sql)
    log.info("schema applied")


async def upsert_users() -> None:
    log.info("upserting %d users", len(USERS))
    async with acquire() as conn:
        for u in USERS:
            await conn.execute(
                """
                INSERT INTO users (slug, email, name, team, role, cities)
                VALUES ($1, $2, $3, $4, $5, $6)
                ON CONFLICT (email) DO UPDATE SET
                  slug = EXCLUDED.slug,
                  name = EXCLUDED.name,
                  team = EXCLUDED.team,
                  role = EXCLUDED.role,
                  cities = EXCLUDED.cities,
                  updated_at = now()
                """,
                u["slug"], u["email"], u["name"], u["team"], u["role"], u["cities"],
            )


async def upsert_wa_templates() -> None:
    log.info("upserting WA templates")
    async with acquire() as conn:
        for t in WA_TEMPLATES:
            await conn.execute(
                "INSERT INTO wa_templates (id, label, body_template, order_idx) "
                "VALUES ($1, $2, $3, $4) "
                "ON CONFLICT (id) DO UPDATE SET "
                "  label = EXCLUDED.label, order_idx = EXCLUDED.order_idx, updated_at = now()",
                t["id"], t["label"], t["body"], t["order"],
            )


async def derive_cp_owners() -> dict:
    """Open a cp_assignments row per broker who has no current owner.
       Tier 1+2 → KAMs (round-robin by city). Tier 3+4 → Ground (prefer added_by Ground member,
       else round-robin by city)."""
    inserted = 0
    async with acquire() as conn:
        users_by_slug = {
            u["slug"]: u["id"]
            for u in await conn.fetch("SELECT slug, id FROM users")
        }
        ground_by_name = {
            u["name"]: u["id"]
            for u in await conn.fetch(
                "SELECT name, id FROM users WHERE team = 'Ground' AND active = true"
            )
        }
        counts: dict[str, int] = defaultdict(int)

        brokers = await conn.fetch(
            """
            SELECT b.id, b.cp_code, b.city, b.added_by, ta.tier
              FROM brokers b
         LEFT JOIN v_broker_current_tier ta ON ta.broker_id = b.id
         LEFT JOIN v_broker_current_owner co ON co.broker_id = b.id
             WHERE co.broker_id IS NULL
               AND b.deleted_at IS NULL
            """
        )
        for b in brokers:
            tier = b["tier"]
            city = b["city"]
            owner_slug = None

            if tier in ("T1", "T2"):
                pool = KAM_BUCKETS.get(city, ["adiksha"])
                owner_slug = min(pool, key=lambda s: counts[s])
            else:
                if b["added_by"] and b["added_by"] in ground_by_name:
                    owner_id = ground_by_name[b["added_by"]]
                    await conn.execute(
                        "INSERT INTO cp_assignments (broker_id, owner_user_id, reason) "
                        "VALUES ($1, $2, 'initial_from_added_by') "
                        "ON CONFLICT DO NOTHING",
                        b["id"], owner_id,
                    )
                    counts[b["added_by"]] += 1
                    inserted += 1
                    continue
                pool = GROUND_BUCKETS.get(city, GROUND_BUCKETS["Gurgaon"])
                owner_slug = min(pool, key=lambda s: counts[s])

            owner_id = users_by_slug.get(owner_slug)
            if not owner_id:
                continue
            await conn.execute(
                "INSERT INTO cp_assignments (broker_id, owner_user_id, reason) "
                "VALUES ($1, $2, 'initial_round_robin') "
                "ON CONFLICT DO NOTHING",
                b["id"], owner_id,
            )
            counts[owner_slug] += 1
            inserted += 1

    log.info("derived %d cp_assignments", inserted)
    return {"inserted": inserted}


async def derive_tier_for_untiered() -> dict:
    """Brokers not present in `18 Broker Tiers` get T3 (D30_active) or T4 (else)."""
    applied = 0
    async with acquire() as conn:
        brokers = await conn.fetch(
            """
            SELECT b.id, b.activity_category
              FROM brokers b
         LEFT JOIN v_broker_current_tier ta ON ta.broker_id = b.id
             WHERE ta.broker_id IS NULL
               AND b.deleted_at IS NULL
            """
        )
        for b in brokers:
            tier = "T3" if (b["activity_category"] or "").startswith("D30") else "T4"
            try:
                await conn.execute(
                    "INSERT INTO tier_assignments (broker_id, tier, reason) "
                    "VALUES ($1, $2, 'auto_initial')",
                    b["id"], tier,
                )
                applied += 1
            except Exception as e:
                log.warning("tier insert failed for %s: %s", b["id"], e)

    log.info("derived %d tier_assignments (T3/T4 fallback)", applied)
    return {"applied": applied}


async def main() -> None:
    await init_pool()
    try:
        await run_schema()
        await upsert_users()
        await upsert_wa_templates()
        log.info("--- first sync from sheets ---")
        sync_out = await sheet_sync.run_all()
        log.info("sheet sync result: %s", json.dumps(sync_out, default=str))
        await derive_tier_for_untiered()
        await derive_cp_owners()
        log.info("bootstrap complete")
    finally:
        await close_pool()


if __name__ == "__main__":
    asyncio.run(main())
