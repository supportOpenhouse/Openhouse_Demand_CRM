-- ============================================================================
-- 009 · Key-handover dates from the AMA-register sheet (2026-06-12)
-- ============================================================================
-- Gap-fills the Analytics "Property ageing" key-handover dates. The acquisitions
-- ("properties") DB only covers ~36% of our units; this table is refreshed daily
-- from the AMA register sheet's Gurgaon / Noida-GN / Ghaziabad tabs
-- (sheet_sync.sync_key_handovers) and MERGED into /api/key-handovers
-- (acquisitions wins on conflict). The frontend's society + flat-digit matcher
-- then maps these to our inventory.
-- Idempotent.
-- ============================================================================
CREATE TABLE IF NOT EXISTS sheet_key_handovers (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  city               text,
  society_name       text NOT NULL,
  unit_no            text NOT NULL,
  key_handover_date  date NOT NULL,
  source_tab         text,
  synced_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (society_name, unit_no)
);
CREATE INDEX IF NOT EXISTS idx_skh_society ON sheet_key_handovers(society_name);
