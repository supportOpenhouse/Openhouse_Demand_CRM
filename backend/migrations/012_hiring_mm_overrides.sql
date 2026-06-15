-- ============================================================================
-- 012 · Hiring planning — manual micro-market fill for blank-MM properties
-- ============================================================================
-- New, fully ISOLATED table for the admin-only "Hiring" tab. Some properties in
-- `all_properties` (mostly Archived) have a blank `micro_market`; an admin can
-- assign the correct MM to a (city, society) here so those units group into the
-- right MM row in the Hiring table.
--
-- The app applies this ONLY as a COALESCE *fallback* —
--   effective_mm = COALESCE(NULLIF(all_properties.micro_market,''), override.micro_market)
-- so a unit's own (real, sheet-sourced) MM ALWAYS wins; the override can only fill
-- a genuinely blank one. It never mutates `all_properties` or any existing table,
-- and nothing outside the Hiring tab reads it.
--
-- Idempotent — safe to re-run.
-- ============================================================================

CREATE TABLE IF NOT EXISTS hiring_mm_overrides (
  city          text NOT NULL,
  society_name  text NOT NULL,
  micro_market  text NOT NULL,
  set_by        text,
  updated_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (city, society_name)
);
