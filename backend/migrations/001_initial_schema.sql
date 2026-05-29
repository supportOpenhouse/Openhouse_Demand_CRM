-- ============================================================================
-- OpenHouse Demand CRM · Initial schema (Postgres 16 on Neon)
-- Subset of BACKEND_SCHEMA.md (16 of 20 tables).
-- Skipped for v1: events, integration_log, feature_flags, cities.
-- Permissions enforced in the API layer (no RLS yet) to keep the v1 surface tight.
-- Idempotent: every CREATE uses IF NOT EXISTS.
-- ============================================================================

CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS citext;
CREATE EXTENSION IF NOT EXISTS btree_gist;
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- ---------------------------------------------------------------------------
-- TIER 1 · master records
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS users (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug               text UNIQUE NOT NULL,                    -- 'akshit','shubham' — matches USERS array in crm.html
  email              citext UNIQUE NOT NULL,
  name               text NOT NULL,
  phone              text,
  team               text NOT NULL CHECK (team IN ('Admin','TL','KAM','Ground')),
  role               text NOT NULL,
  cities             text[] NOT NULL DEFAULT '{}',
  active             boolean NOT NULL DEFAULT true,
  joined_at          date,
  lsq_user_id        text UNIQUE,
  avatar_url         text,
  metadata           jsonb NOT NULL DEFAULT '{}',
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_users_team ON users(team) WHERE active;
CREATE INDEX IF NOT EXISTS idx_users_cities_gin ON users USING gin(cities);

CREATE TABLE IF NOT EXISTS brokers (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  cp_code               text UNIQUE NOT NULL,
  name                  text NOT NULL,
  phone                 text NOT NULL,
  alt_phone             text,
  company               text,
  city                  text NOT NULL,
  micro_markets         text,                                  -- comma-joined to match sheet shape
  localities            text,
  societies             text,
  societies_worked      text,
  visit_sales_managers  text,
  activity_category     text,
  dec_visits            int NOT NULL DEFAULT 0,
  jan_visits            int NOT NULL DEFAULT 0,
  feb_visits            int NOT NULL DEFAULT 0,
  d30_visits            int NOT NULL DEFAULT 0,
  d60_visits            int NOT NULL DEFAULT 0,
  d90_visits            int NOT NULL DEFAULT 0,
  all_time_visits       int NOT NULL DEFAULT 0,
  has_sold              text,
  sales_attributed      int NOT NULL DEFAULT 0,
  bookings_apr_may      int NOT NULL DEFAULT 0,
  bookings_mar_may      int NOT NULL DEFAULT 0,
  added_by              text,                                  -- name string from sheet (legacy compat)
  added_by_user_id      uuid REFERENCES users(id),
  source                text NOT NULL DEFAULT 'sheet_sync',
  lsq_lead_id           text UNIQUE,
  external_id           text,                                  -- sheet 'id' column (legacy compat)
  external_ids          jsonb NOT NULL DEFAULT '{}',
  metadata              jsonb NOT NULL DEFAULT '{}',
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  synced_from_sheet_at  timestamptz,
  deleted_at            timestamptz
);
CREATE INDEX IF NOT EXISTS idx_brokers_phone_active ON brokers(phone) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_brokers_city ON brokers(city) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_brokers_name_trgm ON brokers USING gin(name gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_brokers_activity ON brokers(activity_category, city) WHERE deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS properties (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  property_code         text UNIQUE,                           -- nullable: sheet doesn't always carry one
  property_name         text NOT NULL UNIQUE,                  -- treated as natural key for sheet upsert
  society_name          text NOT NULL,
  city                  text NOT NULL,                         -- maps from sheet's city_name
  micro_market          text,
  locality_or_sector    text,
  configuration         text,
  super_sqft            text,                                  -- text to preserve sheet format (e.g. "1250")
  carpet_sqft           text,
  listing_price         text,                                  -- text to preserve "86.5 L"
  commission            text,
  exit_facing           text,
  balcony_view          text,
  floor                 text,
  furnishing_status     text,
  listing_status        text NOT NULL DEFAULT 'Ready',
  photo_count           text,
  video_added           text,
  sales_manager         text,                                  -- PM name string (legacy compat)
  listed_at             date,
  metadata              jsonb NOT NULL DEFAULT '{}',
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  synced_from_sheet_at  timestamptz,
  deleted_at            timestamptz
);
CREATE INDEX IF NOT EXISTS idx_properties_society ON properties(society_name);
CREATE INDEX IF NOT EXISTS idx_properties_city_status ON properties(city, listing_status) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_properties_name_trgm ON properties USING gin(property_name gin_trgm_ops);

CREATE TABLE IF NOT EXISTS buyers (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  lead_key            text UNIQUE,
  name                text NOT NULL,
  phone               text,
  alt_phone           text,
  email               citext,
  profession          text,
  registration_date   date,
  lsq_lead_id         text UNIQUE,
  metadata            jsonb NOT NULL DEFAULT '{}',
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_buyers_phone ON buyers(phone);
CREATE INDEX IF NOT EXISTS idx_buyers_name_trgm ON buyers USING gin(name gin_trgm_ops);

-- ---------------------------------------------------------------------------
-- TIER 2 · activity / transactional
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS visits (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  visit_code               text UNIQUE,                         -- the sheet 'id' column ("7820")
  buyer_id                 uuid REFERENCES buyers(id),
  broker_id                uuid REFERENCES brokers(id),
  property_id              uuid REFERENCES properties(id),

  -- Denormalized fields kept on the row for fast read (mirror of seed.json shape)
  cp_code                  text,
  broker_name              text,
  broker_contact           text,
  broker_alt_contact       text,
  company_name             text,
  city                     text,
  buyer_name               text,
  buyer_contact            text,
  buyer_registration_date  date,
  lead_key                 text,
  lead_occurrence_count    int,
  first_added_by           text,
  added_by                 text,
  sales_manager            text,                               -- the RM name from sheet
  source                   text,
  status                   text,                               -- upcoming / completed / cancelled (sheet column)
  selected_date            date,
  selected_time            text,
  visit_date               date,
  society_name             text,
  unit_address_line1       text,
  unit_address_line2       text,
  floor                    text,
  furnishing_status        text,
  listing_status           text,                               -- sheet's per-visit listing snapshot
  sales_feedback           text,
  buyer_feedback           text,
  all_feedback             text,
  reminder_status          text,
  profession               text,
  intent                   jsonb NOT NULL DEFAULT '{}',        -- the 6 buyer-intent fields

  -- Projection from latest followup (updated by trigger below)
  lead_status              text NOT NULL DEFAULT 'select_status',  -- hot/warm/cold/dead/future_prospect/select_status (sheet col)
  current_stage            text NOT NULL DEFAULT 'upcoming',
  current_status           text NOT NULL DEFAULT 'unc',
  latest_followup_id       uuid,
  latest_followup_at       timestamptz,
  latest_followup_date     date,
  latest_followup_note     text,
  next_followup_date       date,
  revisit_date             timestamptz,

  cancelled_reason         text,
  metadata                 jsonb NOT NULL DEFAULT '{}',
  external_ids             jsonb NOT NULL DEFAULT '{}',
  lsq_visit_activity_id    text UNIQUE,
  created_at               timestamptz NOT NULL DEFAULT now(),
  updated_at               timestamptz NOT NULL DEFAULT now(),
  synced_from_sheet_at     timestamptz,
  synced_from_lsq_at       timestamptz
);
CREATE INDEX IF NOT EXISTS idx_visits_broker_recent ON visits(broker_id, visit_date DESC);
CREATE INDEX IF NOT EXISTS idx_visits_cp_recent ON visits(cp_code, visit_date DESC);
CREATE INDEX IF NOT EXISTS idx_visits_buyer_recent ON visits(buyer_id, visit_date DESC);
CREATE INDEX IF NOT EXISTS idx_visits_property ON visits(property_id) WHERE property_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_visits_society ON visits(society_name);
CREATE INDEX IF NOT EXISTS idx_visits_stage ON visits(current_stage, visit_date DESC);
CREATE INDEX IF NOT EXISTS idx_visits_followup_due ON visits(next_followup_date)
  WHERE current_stage NOT IN ('booking','ats','not_interested','need_more','cancelled');
CREATE INDEX IF NOT EXISTS idx_visits_visit_date ON visits(visit_date DESC);

-- followups: append-only, partitioned by month
CREATE TABLE IF NOT EXISTS followups (
  id                       uuid NOT NULL DEFAULT gen_random_uuid(),
  visit_id                 uuid NOT NULL REFERENCES visits(id),
  by_user_id               uuid NOT NULL REFERENCES users(id),
  buyer_status             text NOT NULL CHECK (buyer_status IN ('hot','warm','cold','dead','future_prospect','unc')),
  stage                    text NOT NULL,
  note                     text NOT NULL CHECK (length(trim(note)) > 0),
  next_followup_date       date,
  revisit_date             timestamptz,
  previous_stage           text,
  previous_status          text,
  resolved_nudge_ids       uuid[] NOT NULL DEFAULT '{}',
  is_correction            boolean NOT NULL DEFAULT false,
  lsq_activity_id          text,
  lsq_activity_type        int,
  source                   text NOT NULL DEFAULT 'app',
  metadata                 jsonb NOT NULL DEFAULT '{}',
  created_at               timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (created_at, id)
) PARTITION BY RANGE (created_at);

-- Pre-create 14 months of partitions (May 2026 → Jun 2027). A monthly job extends this.
DO $$
DECLARE
  m date := date '2026-05-01';
  i int;
BEGIN
  FOR i IN 0..13 LOOP
    EXECUTE format(
      'CREATE TABLE IF NOT EXISTS followups_%s PARTITION OF followups FOR VALUES FROM (%L) TO (%L);',
      to_char(m + (i || ' months')::interval, 'YYYY_MM'),
      (m + (i || ' months')::interval)::date,
      (m + ((i+1) || ' months')::interval)::date
    );
  END LOOP;
END $$;

CREATE INDEX IF NOT EXISTS idx_followups_visit ON followups(visit_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_followups_by_user ON followups(by_user_id, created_at DESC);
-- Postgres won't allow a UNIQUE index on a partitioned table unless it includes the
-- partition key (created_at). Regular index for fast lookup; LSQ writer dedups in
-- app code via "WHERE NOT EXISTS" (see docs/LSQ_HANDOVER.md §4).
CREATE INDEX IF NOT EXISTS idx_followups_lsq ON followups(lsq_activity_id) WHERE lsq_activity_id IS NOT NULL;

-- Trigger: when a followup is inserted, project it onto visits.current_* (last-wins by created_at)
CREATE OR REPLACE FUNCTION project_followup_onto_visit() RETURNS trigger AS $$
BEGIN
  UPDATE visits SET
    lead_status           = CASE WHEN NEW.buyer_status = 'unc' THEN 'select_status' ELSE NEW.buyer_status END,
    current_stage         = NEW.stage,
    current_status        = NEW.buyer_status,
    latest_followup_id    = NEW.id,
    latest_followup_at    = NEW.created_at,
    latest_followup_date  = NEW.created_at::date,
    latest_followup_note  = NEW.note,
    next_followup_date    = NEW.next_followup_date,
    revisit_date          = NEW.revisit_date,
    updated_at            = now()
  WHERE id = NEW.visit_id
    AND (latest_followup_at IS NULL OR NEW.created_at > latest_followup_at);
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_project_followup ON followups;
CREATE TRIGGER trg_project_followup
  AFTER INSERT ON followups
  FOR EACH ROW EXECUTE FUNCTION project_followup_onto_visit();

CREATE TABLE IF NOT EXISTS engagements (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  broker_id                uuid NOT NULL REFERENCES brokers(id),
  by_user_id               uuid NOT NULL REFERENCES users(id),
  inventory_shared         boolean,
  recording_done           boolean,
  listing_done             boolean,
  listing_link             text,
  listing_followup_date    date,
  support_asked            boolean,
  support_details          text,
  remarks                  text,
  notes                    text NOT NULL CHECK (length(trim(notes)) > 0),
  metadata                 jsonb NOT NULL DEFAULT '{}',
  created_at               timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_engagements_broker ON engagements(broker_id, created_at DESC);

CREATE TABLE IF NOT EXISTS nudges (
  id                          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  visit_id                    uuid NOT NULL REFERENCES visits(id),
  from_user_id                uuid NOT NULL REFERENCES users(id),
  to_user_id                  uuid NOT NULL REFERENCES users(id),
  message                     text,
  priority                    text NOT NULL DEFAULT 'normal' CHECK (priority IN ('low','normal','high')),
  resolved_at                 timestamptz,
  resolved_by_followup_id     uuid,
  metadata                    jsonb NOT NULL DEFAULT '{}',
  created_at                  timestamptz NOT NULL DEFAULT now(),
  CHECK (from_user_id <> to_user_id)
);
CREATE INDEX IF NOT EXISTS idx_nudges_open_to ON nudges(to_user_id, created_at DESC) WHERE resolved_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_nudges_visit_open ON nudges(visit_id) WHERE resolved_at IS NULL;

-- notifications: bigserial, partitioned by month
CREATE TABLE IF NOT EXISTS notifications (
  id              bigint NOT NULL GENERATED ALWAYS AS IDENTITY,
  to_user_id      uuid NOT NULL REFERENCES users(id),
  from_user_id    uuid REFERENCES users(id),
  type            text NOT NULL,
  ref_type        text,
  ref_id          uuid,
  text            text NOT NULL,
  action          text,
  read_at         timestamptz,
  delivered_via   text[] NOT NULL DEFAULT ARRAY['inapp'],
  metadata        jsonb NOT NULL DEFAULT '{}',
  created_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (created_at, id)
) PARTITION BY RANGE (created_at);

DO $$
DECLARE
  m date := date '2026-05-01';
  i int;
BEGIN
  FOR i IN 0..13 LOOP
    EXECUTE format(
      'CREATE TABLE IF NOT EXISTS notifications_%s PARTITION OF notifications FOR VALUES FROM (%L) TO (%L);',
      to_char(m + (i || ' months')::interval, 'YYYY_MM'),
      (m + (i || ' months')::interval)::date,
      (m + ((i+1) || ' months')::interval)::date
    );
  END LOOP;
END $$;

CREATE INDEX IF NOT EXISTS idx_notifs_unread ON notifications(to_user_id, created_at DESC) WHERE read_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_notifs_user_recent ON notifications(to_user_id, created_at DESC);

-- ---------------------------------------------------------------------------
-- TIER 3 · temporal assignments
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS cp_assignments (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  broker_id                uuid NOT NULL REFERENCES brokers(id),
  owner_user_id            uuid NOT NULL REFERENCES users(id),
  effective_from           timestamptz NOT NULL DEFAULT now(),
  effective_to             timestamptz,
  assigned_by_user_id      uuid REFERENCES users(id),
  reason                   text,
  metadata                 jsonb NOT NULL DEFAULT '{}',
  created_at               timestamptz NOT NULL DEFAULT now(),
  CHECK (effective_to IS NULL OR effective_to > effective_from),
  EXCLUDE USING gist (broker_id WITH =, tstzrange(effective_from, effective_to, '[)') WITH &&)
);
CREATE INDEX IF NOT EXISTS idx_cp_assn_current ON cp_assignments(broker_id) WHERE effective_to IS NULL;
CREATE INDEX IF NOT EXISTS idx_cp_assn_owner_current ON cp_assignments(owner_user_id) WHERE effective_to IS NULL;

CREATE TABLE IF NOT EXISTS property_assignments (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id              uuid NOT NULL REFERENCES properties(id),
  pm_user_id               uuid NOT NULL REFERENCES users(id),
  effective_from           timestamptz NOT NULL DEFAULT now(),
  effective_to             timestamptz,
  assigned_by_user_id      uuid REFERENCES users(id),
  metadata                 jsonb NOT NULL DEFAULT '{}',
  created_at               timestamptz NOT NULL DEFAULT now(),
  CHECK (effective_to IS NULL OR effective_to > effective_from),
  EXCLUDE USING gist (property_id WITH =, tstzrange(effective_from, effective_to, '[)') WITH &&)
);
CREATE INDEX IF NOT EXISTS idx_prop_assn_current ON property_assignments(property_id) WHERE effective_to IS NULL;
CREATE INDEX IF NOT EXISTS idx_prop_assn_pm_current ON property_assignments(pm_user_id) WHERE effective_to IS NULL;

CREATE TABLE IF NOT EXISTS tier_assignments (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  broker_id                uuid NOT NULL REFERENCES brokers(id),
  tier                     text NOT NULL CHECK (tier IN ('T1','T2','T3','T4')),
  tier_rank                int,
  effective_from           timestamptz NOT NULL DEFAULT now(),
  effective_to             timestamptz,
  set_by_user_id           uuid REFERENCES users(id),
  reason                   text,
  metadata                 jsonb NOT NULL DEFAULT '{}',
  created_at               timestamptz NOT NULL DEFAULT now(),
  CHECK (effective_to IS NULL OR effective_to > effective_from),
  EXCLUDE USING gist (broker_id WITH =, tstzrange(effective_from, effective_to, '[)') WITH &&)
);
CREATE INDEX IF NOT EXISTS idx_tier_current ON tier_assignments(broker_id) WHERE effective_to IS NULL;

CREATE TABLE IF NOT EXISTS user_daily_tasks (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id             uuid NOT NULL REFERENCES users(id),
  task_date           date NOT NULL DEFAULT current_date,
  kind                text NOT NULL CHECK (kind IN ('pinned_cp','message')),
  broker_id           uuid REFERENCES brokers(id),
  message_text        text,
  message_priority    text CHECK (message_priority IN ('low','normal','high')),
  from_user_id        uuid REFERENCES users(id),
  completed_at        timestamptz,
  metadata            jsonb NOT NULL DEFAULT '{}',
  created_at          timestamptz NOT NULL DEFAULT now(),
  CHECK (
    (kind = 'pinned_cp' AND broker_id IS NOT NULL) OR
    (kind = 'message'   AND message_text IS NOT NULL)
  )
);
CREATE INDEX IF NOT EXISTS idx_tasks_user_date ON user_daily_tasks(user_id, task_date DESC);
CREATE INDEX IF NOT EXISTS idx_tasks_open ON user_daily_tasks(user_id, task_date) WHERE completed_at IS NULL;

-- ---------------------------------------------------------------------------
-- TIER 4 · sync log
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS sheet_sync_log (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sheet_name               text NOT NULL,
  sheet_id                 text,
  tab_name                 text,
  run_started_at           timestamptz NOT NULL DEFAULT now(),
  run_finished_at          timestamptz,
  rows_seen                int NOT NULL DEFAULT 0,
  rows_inserted            int NOT NULL DEFAULT 0,
  rows_updated             int NOT NULL DEFAULT 0,
  rows_skipped             int NOT NULL DEFAULT 0,
  rows_failed              int NOT NULL DEFAULT 0,
  errors                   jsonb NOT NULL DEFAULT '[]',
  status                   text NOT NULL CHECK (status IN ('running','success','failed','partial')),
  triggered_by             text NOT NULL DEFAULT 'cron',
  triggered_by_user_id     uuid REFERENCES users(id),
  metadata                 jsonb NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS idx_sync_log_sheet_time ON sheet_sync_log(sheet_name, run_started_at DESC);

-- LSQ + outbound API call log. Used by the LSQ migration dev for backfill,
-- forward-sync, and reconciliation errors. See docs/LSQ_HANDOVER.md §6-7.
CREATE TABLE IF NOT EXISTS integration_log (
  id                  bigserial PRIMARY KEY,
  direction           text NOT NULL CHECK (direction IN ('inbound','outbound')),
  system              text NOT NULL,                    -- 'lsq' / 'sheets' / 'wa' / ...
  endpoint            text,
  request_method      text,
  request_body        jsonb,
  response_status     int,
  response_body       jsonb,
  attempt             int NOT NULL DEFAULT 1,
  succeeded           boolean NOT NULL DEFAULT false,
  severity            text DEFAULT 'info' CHECK (severity IN ('info','warning','error')),
  correlation_id      text,
  latency_ms          int,
  metadata            jsonb NOT NULL DEFAULT '{}',
  created_at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_intlog_system_time ON integration_log(system, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_intlog_failures ON integration_log(system, created_at DESC) WHERE succeeded = false;

-- ---------------------------------------------------------------------------
-- TIER 5 · config
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS wa_templates (
  id                  text PRIMARY KEY,
  label               text NOT NULL,
  description         text,
  body_template       text NOT NULL,
  cities              text[] NOT NULL DEFAULT '{}',
  roles_allowed       text[] NOT NULL DEFAULT '{}',
  active              boolean NOT NULL DEFAULT true,
  order_idx           int NOT NULL DEFAULT 0,
  version             int NOT NULL DEFAULT 1,
  metadata            jsonb NOT NULL DEFAULT '{}',
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS system_config (
  key           text PRIMARY KEY,
  value         jsonb NOT NULL,
  description   text,
  updated_by    uuid REFERENCES users(id),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

INSERT INTO system_config (key, value, description) VALUES
  ('stages',
    '["upcoming","avfu","revisit_scheduled","after_revisit_fu","negotiation","booking","ats","future_prospect","not_interested","need_more","cancelled"]'::jsonb,
    'Canonical pipeline stages, display order')
ON CONFLICT (key) DO NOTHING;

INSERT INTO system_config (key, value, description) VALUES
  ('statuses',
    '["hot","warm","cold","dead","future_prospect","unc"]'::jsonb,
    'Buyer thermal statuses')
ON CONFLICT (key) DO NOTHING;

INSERT INTO system_config (key, value, description) VALUES
  ('overdue_days', '3'::jsonb, 'Days past next_followup_date before overdue')
ON CONFLICT (key) DO NOTHING;

-- ---------------------------------------------------------------------------
-- Convenience views (read-time projections — cheap on this volume)
-- ---------------------------------------------------------------------------

CREATE OR REPLACE VIEW v_broker_current_owner AS
  SELECT broker_id, owner_user_id, effective_from
    FROM cp_assignments
   WHERE effective_to IS NULL;

CREATE OR REPLACE VIEW v_broker_current_tier AS
  SELECT broker_id, tier, tier_rank, effective_from
    FROM tier_assignments
   WHERE effective_to IS NULL;

CREATE OR REPLACE VIEW v_property_current_pm AS
  SELECT property_id, pm_user_id, effective_from
    FROM property_assignments
   WHERE effective_to IS NULL;
