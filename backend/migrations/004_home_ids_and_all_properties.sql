-- ============================================================================
-- 004 · Source-system IDs on synced rows + All Properties mirror table
-- ============================================================================
-- 1. Persist the new sheet columns added to the source pipelines (2026-06-07):
--      visitors_data  → visits.home_id                (oh-core home id of the visit)
--      live_inventory → properties.home_id / supply_form_uid / sales_manager_contact
-- 2. Create `all_properties`, a flat mirror of the live-inventory sheet's
--    "All Properties" tab (every listing_status incl. Sold/Archived). Shaped
--    like `properties` and upserted by property_name on the same 15-min cron
--    (sheet_sync.sync_all_properties). No PM-assignment machinery — that stays
--    on the active `properties` table only.
-- Idempotent: ADD COLUMN IF NOT EXISTS / CREATE TABLE IF NOT EXISTS.
-- ============================================================================

-- 1. visitors_data → visits
ALTER TABLE visits
  ADD COLUMN IF NOT EXISTS home_id text;

-- 2. live_inventory → properties
ALTER TABLE properties
  ADD COLUMN IF NOT EXISTS home_id               text,
  ADD COLUMN IF NOT EXISTS supply_form_uid       text,
  ADD COLUMN IF NOT EXISTS sales_manager_contact text;

-- 3. all_properties — mirror of the "All Properties" tab
CREATE TABLE IF NOT EXISTS all_properties (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  property_name         text NOT NULL UNIQUE,                 -- natural key for sheet upsert
  society_name          text NOT NULL,
  city                  text NOT NULL,                        -- maps from sheet's city_name
  micro_market          text,
  locality_or_sector    text,
  configuration         text,
  super_sqft            text,
  carpet_sqft           text,
  area_unit             text,
  listing_price         text,
  commission            text,
  exit_facing           text,
  balcony_view          text,
  listing_status        text NOT NULL DEFAULT 'Ready',        -- Ready/Coming Soon/Booked/Sold/Archived
  photo_count           text,
  video_added           text,
  sales_manager         text,
  sales_manager_contact text,
  home_id               text,
  supply_form_uid       text,
  metadata              jsonb NOT NULL DEFAULT '{}',
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  synced_from_sheet_at  timestamptz,
  deleted_at            timestamptz
);
CREATE INDEX IF NOT EXISTS idx_all_properties_society ON all_properties(society_name);
CREATE INDEX IF NOT EXISTS idx_all_properties_city_status ON all_properties(city, listing_status) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_all_properties_home_id ON all_properties(home_id) WHERE home_id IS NOT NULL;
