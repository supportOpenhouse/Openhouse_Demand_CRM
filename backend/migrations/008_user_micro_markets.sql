-- ============================================================================
-- 008 · MM-manager access — per-user micro_markets (2026-06-12)
-- ============================================================================
-- A user with micro_markets set becomes a "micro-market manager": scope_for_user
-- grants them every property + visit in those micro-markets (across all PMs/RMs
-- there), overriding the team/city scope. Empty {} = no change (default, everyone
-- else is unaffected). Mirrors the existing `cities text[]` column.
-- Idempotent.
-- ============================================================================
ALTER TABLE users ADD COLUMN IF NOT EXISTS micro_markets text[] NOT NULL DEFAULT '{}';
