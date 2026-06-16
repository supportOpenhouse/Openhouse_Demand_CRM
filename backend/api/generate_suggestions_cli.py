"""Daily AI-Suggestions batch generator, run by the Render CRON CONTAINER
(`python -m api.generate_suggestions_cli`) — deliberately NOT via the web service.

The brief build does a full snapshot pass (same cost as /api/seed), which for the
whole roster takes a few minutes of CPU. Running it in the cron's own container
keeps that load off the web service, so the live app isn't degraded at 09:30 when
people are logging in. Idempotent: upserts one row per user per day.

Manual run (writes to whatever DATABASE_URL points at):  python -m api.generate_suggestions_cli
"""
from __future__ import annotations

import asyncio
import datetime as dt
import json
import logging

from . import ai_suggestions, config, seed_snapshot  # noqa: F401 (config validates env on import)
from .db import init_pool, close_pool, acquire

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("ai_cron")

_USER_COLS = ("id, slug, email, name, team, role, cities, micro_markets, "
              "extra_cities, extra_cities_enabled, active")


async def run() -> dict:
    await init_pool()
    try:
        today = dt.date.today()
        async with acquire() as conn:
            snap = await seed_snapshot.build(conn)
            users = [dict(u) for u in await conn.fetch(f"SELECT {_USER_COLS} FROM users WHERE active")]
        log.info("snapshot built; generating briefs for %d active users", len(users))

        sem = asyncio.Semaphore(6)

        async def _one(u):
            async with sem:
                try:
                    payload = await asyncio.to_thread(
                        ai_suggestions.build_for_user, snap, u, seed_snapshot.scope_for_user)
                    return u["id"], payload
                except Exception:  # one user's failure must not abort the batch
                    log.exception("brief failed for %s", u.get("slug"))
                    return None

        results = [r for r in await asyncio.gather(*[_one(u) for u in users]) if r]
        async with acquire() as conn:
            for uid, payload in results:
                await conn.execute(
                    """
                    INSERT INTO ai_suggestions (user_id, for_date, payload)
                    VALUES ($1, $2, $3::jsonb)
                    ON CONFLICT (user_id, for_date)
                    DO UPDATE SET payload = EXCLUDED.payload, generated_at = now()
                    """,
                    uid, today, json.dumps(payload),
                )
        log.info("done: generated %d/%d briefs for %s", len(results), len(users), today.isoformat())
        return {"generated": len(results), "users": len(users)}
    finally:
        await close_pool()


if __name__ == "__main__":
    asyncio.run(run())
