-- ============================================================================
-- Top Brokers · 99acres  (one-off market-intel import)
-- Source: "New Demand Flow - Top Brokers by Society" CSV.
-- Logical name requested: "top brokers-99 acres" → stored as top_brokers_99acres
-- (a valid unquoted Postgres identifier). One row per (society, rank) broker.
-- Idempotent DDL; the loader TRUNCATEs + reloads so re-running gives a clean set.
-- ============================================================================

CREATE TABLE IF NOT EXISTS top_brokers_99acres (
  id                    bigserial PRIMARY KEY,
  society               text NOT NULL,
  city                  text,
  micro_market          text,
  rank                  int,
  broker_name           text,
  agency                text,
  listings_30d          int,
  listings_90d          int,
  listings_180d         int,
  listings_all          int,
  latest_listing_date   date,
  latest_listing_link   text,
  agency_address        text,
  other_ncr_societies   text,           -- "Other NCR societies (top 8)" — semicolon-joined
  oh_match_type         text,           -- e.g. 'Agency = OH CP firm (exact)', 'No match'
  oh_match_details      text,
  phone                 text,           -- CRM-entered broker contact (add/edit/clear in the property modal)
  imported_at           timestamptz NOT NULL DEFAULT now()
);

-- phone may be absent on a table created before this column existed — keep idempotent.
ALTER TABLE top_brokers_99acres ADD COLUMN IF NOT EXISTS phone text;

CREATE INDEX IF NOT EXISTS idx_top_brokers_99acres_society ON top_brokers_99acres(society);
CREATE INDEX IF NOT EXISTS idx_top_brokers_99acres_city    ON top_brokers_99acres(city);
CREATE INDEX IF NOT EXISTS idx_top_brokers_99acres_rank    ON top_brokers_99acres(society, rank);
