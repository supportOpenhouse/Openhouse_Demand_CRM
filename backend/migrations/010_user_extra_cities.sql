-- ============================================================================
-- 010 · KAM extra-city visit access — per-user toggle + cities (2026-06-14)
-- ============================================================================
-- A KAM with extra_cities_enabled=true AND extra_cities set ALSO sees every visit
-- in those cities (on top of their own CPs), plus those visits' CPs so the cards
-- and pop-ups resolve. scope_for_user applies this in the KAM branch ONLY.
-- Default off/empty {} → no scope change for anyone (every other user, and any KAM
-- left off, is byte-identical to today). Admin-editable in the User modal.
-- Idempotent. Mirrors the existing `cities` / `micro_markets` text[] columns.
-- ============================================================================
ALTER TABLE users ADD COLUMN IF NOT EXISTS extra_cities text[] NOT NULL DEFAULT '{}';
ALTER TABLE users ADD COLUMN IF NOT EXISTS extra_cities_enabled boolean NOT NULL DEFAULT false;
