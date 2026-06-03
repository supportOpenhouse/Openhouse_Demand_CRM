"""Load the "Top Brokers by Society" (99acres) CSV into top_brokers_99acres.

Applies migrations/002_top_brokers_99acres.sql, then TRUNCATEs and bulk-loads the
CSV. Idempotent — re-running replaces the table contents with the file's rows.

    python -m api.import_top_brokers ["/path/to/file.csv"]

Default CSV path: ~/Downloads/New Demand Flow - Top Brokers by Society.csv
"""
from __future__ import annotations

import asyncio
import csv
import datetime as dt
import logging
import os
import sys
from pathlib import Path

from . import config
from .db import init_pool, close_pool, acquire

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(name)s %(levelname)s %(message)s")
log = logging.getLogger("import_top_brokers")

DEFAULT_CSV = os.path.expanduser(
    "~/Downloads/New Demand Flow - Top Brokers by Society.csv"
)

# CSV header  ->  table column
COLMAP = {
    "Society": "society",
    "City": "city",
    "Micro-market": "micro_market",
    "Rank": "rank",
    "Broker Name": "broker_name",
    "Agency": "agency",
    "Listings 30d": "listings_30d",
    "Listings 90d": "listings_90d",
    "Listings 180d": "listings_180d",
    "Listings all": "listings_all",
    "Latest Listing Date": "latest_listing_date",
    "Latest Listing Link": "latest_listing_link",
    "Agency Address": "agency_address",
    "Other NCR societies (top 8)": "other_ncr_societies",
    "OH Match Type": "oh_match_type",
    "OH Match Details": "oh_match_details",
}
INT_COLS = {"rank", "listings_30d", "listings_90d", "listings_180d", "listings_all"}
DATE_COLS = {"latest_listing_date"}

INSERT_COLS = [
    "society", "city", "micro_market", "rank", "broker_name", "agency",
    "listings_30d", "listings_90d", "listings_180d", "listings_all",
    "latest_listing_date", "latest_listing_link", "agency_address",
    "other_ncr_societies", "oh_match_type", "oh_match_details",
]


def _int(v: str):
    v = (v or "").strip()
    if not v:
        return None
    try:
        return int(float(v))
    except ValueError:
        return None


def _date(v: str):
    v = (v or "").strip()
    if not v:
        return None
    try:
        return dt.date.fromisoformat(v[:10])
    except ValueError:
        return None


def _txt(v: str):
    v = (v or "").strip()
    return v or None


def read_rows(csv_path: str) -> list[tuple]:
    with open(csv_path, newline="", encoding="utf-8-sig") as f:
        reader = csv.DictReader(f)
        missing = [h for h in COLMAP if h not in reader.fieldnames]
        if missing:
            raise RuntimeError(f"CSV missing expected columns: {missing}\nGot: {reader.fieldnames}")
        rows = []
        for raw in reader:
            rec = {}
            for hdr, col in COLMAP.items():
                val = raw.get(hdr, "")
                if col in INT_COLS:
                    rec[col] = _int(val)
                elif col in DATE_COLS:
                    rec[col] = _date(val)
                else:
                    rec[col] = _txt(val)
            if not rec["society"]:           # skip blank/spacer lines
                continue
            rows.append(tuple(rec[c] for c in INSERT_COLS))
    return rows


async def run_schema() -> None:
    sql_path = config.MIGRATIONS_DIR / "002_top_brokers_99acres.sql"
    if not sql_path.exists():
        raise RuntimeError(f"Migration not found: {sql_path}")
    async with acquire() as conn:
        await conn.execute(sql_path.read_text())
    log.info("schema applied (top_brokers_99acres)")


async def load(csv_path: str) -> dict:
    rows = read_rows(csv_path)
    log.info("parsed %d rows from %s", len(rows), csv_path)
    async with acquire() as conn:
        async with conn.transaction():
            await conn.execute("TRUNCATE top_brokers_99acres RESTART IDENTITY")
            await conn.copy_records_to_table(
                "top_brokers_99acres", records=rows, columns=INSERT_COLS
            )
        total = await conn.fetchval("SELECT count(*) FROM top_brokers_99acres")
        societies = await conn.fetchval("SELECT count(DISTINCT society) FROM top_brokers_99acres")
    log.info("loaded %d rows across %d societies", total, societies)
    return {"rows": total, "societies": societies}


async def main() -> None:
    csv_path = sys.argv[1] if len(sys.argv) > 1 else DEFAULT_CSV
    if not Path(csv_path).exists():
        raise SystemExit(f"CSV not found: {csv_path}")
    await init_pool()
    try:
        await run_schema()
        out = await load(csv_path)
        log.info("done: %s", out)
    finally:
        await close_pool()


if __name__ == "__main__":
    asyncio.run(main())
