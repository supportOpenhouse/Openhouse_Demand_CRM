"""Neon Postgres pool. asyncpg with a small connection ceiling for Render's free tier."""
from __future__ import annotations

import asyncpg
from contextlib import asynccontextmanager
from . import config

_pool: asyncpg.Pool | None = None


async def init_pool() -> asyncpg.Pool:
    global _pool
    if _pool is None:
        _pool = await asyncpg.create_pool(
            dsn=config.DATABASE_URL,
            min_size=1,
            max_size=8,
            command_timeout=30,
            statement_cache_size=0,  # Neon's pgbouncer is in transaction-pool mode
        )
    return _pool


async def close_pool() -> None:
    global _pool
    if _pool is not None:
        await _pool.close()
        _pool = None


def pool() -> asyncpg.Pool:
    if _pool is None:
        raise RuntimeError("DB pool not initialized — call init_pool() first")
    return _pool


@asynccontextmanager
async def acquire():
    async with pool().acquire() as conn:
        yield conn
