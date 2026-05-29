# Backend Schema — Full DDL Reference

> Every table, every column, every index, every constraint.
> Companion to [SARANSH_HANDOVER.md](SARANSH_HANDOVER.md).
> Target: Postgres 16+ on Neon.

---

## Conventions

- All ids are `uuid` PKs (except `notifications` and `events` where we use `bigserial` for monotonic ordering at scale).
- All timestamp columns are `timestamptz` (never naive timestamps).
- Soft delete via `deleted_at IS NULL` where applicable.
- Every table has a `metadata jsonb DEFAULT '{}'` column for forward-compatible field additions.
- Phone numbers are stored normalized to E.164 (`+919999912345`).
- All enums are `text CHECK (... IN (...))` — not Postgres enum types — so admins can change valid values via `system_config` without DDL.

---

## Extension requirements

```sql
CREATE EXTENSION IF NOT EXISTS pgcrypto;     -- for gen_random_uuid()
CREATE EXTENSION IF NOT EXISTS citext;       -- case-insensitive email
CREATE EXTENSION IF NOT EXISTS btree_gist;   -- for EXCLUDE constraints on temporal tables
CREATE EXTENSION IF NOT EXISTS pg_trgm;      -- for fuzzy search on broker names
```

---

## TIER 1 — Master records

### Table 1: `users`

```sql
CREATE TABLE users (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email              citext UNIQUE NOT NULL,
  name               text NOT NULL,
  phone              text,
  team               text NOT NULL CHECK (team IN ('Admin','TL','KAM','Ground')),
  role               text NOT NULL,              -- 'admin','tl_head','tl_closer','kam','kam_tl','ground'
  cities             text[] NOT NULL DEFAULT '{}',
  active             boolean NOT NULL DEFAULT true,
  joined_at          date,
  lsq_user_id        text UNIQUE,                -- for LSQ sync
  avatar_url         text,
  metadata           jsonb NOT NULL DEFAULT '{}',
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  created_by         uuid REFERENCES users(id),
  updated_by         uuid REFERENCES users(id)
);

CREATE INDEX idx_users_team ON users(team) WHERE active;
CREATE INDEX idx_users_role ON users(role) WHERE active;
CREATE INDEX idx_users_cities_gin ON users USING gin(cities);
```

### Table 2: `brokers`

```sql
CREATE TABLE brokers (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  cp_code               text UNIQUE NOT NULL,
  name                  text NOT NULL,
  phone                 text NOT NULL,
  alt_phone             text,
  company               text,
  city                  text NOT NULL,
  micro_markets         text[] NOT NULL DEFAULT '{}',
  localities            text[] NOT NULL DEFAULT '{}',
  societies_worked      text[] NOT NULL DEFAULT '{}',
  activity_category     text,                    -- L30_new / D30_active / D60_active / D90_active / dormant
  dec_visits            int DEFAULT 0,
  jan_visits            int DEFAULT 0,
  feb_visits            int DEFAULT 0,
  d30_visits            int DEFAULT 0,           -- maintained by trigger on visits
  d60_visits            int DEFAULT 0,
  d90_visits            int DEFAULT 0,
  all_time_visits       int DEFAULT 0,
  has_sold              boolean DEFAULT false,
  sales_attributed      int DEFAULT 0,
  bookings_count        int DEFAULT 0,
  added_by_user_id      uuid REFERENCES users(id),
  source                text NOT NULL DEFAULT 'sheet_sync',
  lsq_lead_id           text UNIQUE,
  external_ids          jsonb NOT NULL DEFAULT '{}',
  metadata              jsonb NOT NULL DEFAULT '{}',
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  synced_from_sheet_at  timestamptz,
  deleted_at            timestamptz
);

CREATE UNIQUE INDEX idx_brokers_phone_active ON brokers(phone) WHERE deleted_at IS NULL;
CREATE INDEX idx_brokers_city ON brokers(city) WHERE deleted_at IS NULL;
CREATE INDEX idx_brokers_mm_gin ON brokers USING gin(micro_markets);
CREATE INDEX idx_brokers_societies_gin ON brokers USING gin(societies_worked);
CREATE INDEX idx_brokers_metadata_gin ON brokers USING gin(metadata jsonb_path_ops);
CREATE INDEX idx_brokers_name_trgm ON brokers USING gin(name gin_trgm_ops);
CREATE INDEX idx_brokers_company_trgm ON brokers USING gin(company gin_trgm_ops);
CREATE INDEX idx_brokers_activity ON brokers(activity_category, city) WHERE deleted_at IS NULL;
```

### Table 3: `properties`

```sql
CREATE TABLE properties (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  property_code         text UNIQUE NOT NULL,
  property_name         text NOT NULL,
  society_name          text NOT NULL,
  city                  text NOT NULL,
  micro_market          text,
  locality_or_sector    text,
  configuration         text,                    -- '3BHK', '2.5BHK'
  super_sqft            numeric,
  carpet_sqft           numeric,
  listing_price         numeric,                 -- INR (parsed from "86.5 L" → 8650000)
  commission_pct        numeric,
  exit_facing           text,
  balcony_view          text,
  floor                 text,
  furnishing_status     text,
  listing_status        text NOT NULL CHECK (listing_status IN ('Ready','Coming Soon','Sold','Archived')),
  photo_count           int DEFAULT 0,
  video_added           boolean DEFAULT false,
  listed_at             date,
  metadata              jsonb NOT NULL DEFAULT '{}',
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  synced_from_sheet_at  timestamptz,
  deleted_at            timestamptz
);

CREATE INDEX idx_properties_society ON properties(society_name);
CREATE INDEX idx_properties_city_status ON properties(city, listing_status) WHERE deleted_at IS NULL;
CREATE INDEX idx_properties_mm ON properties(micro_market);
CREATE INDEX idx_properties_name_trgm ON properties USING gin(property_name gin_trgm_ops);
```

### Table 4: `buyers`

```sql
CREATE TABLE buyers (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  lead_key            text UNIQUE,
  name                text NOT NULL,
  phone               text NOT NULL,
  alt_phone           text,
  email               citext,
  profession          text,
  registration_date   date,
  lsq_lead_id         text UNIQUE,
  metadata            jsonb NOT NULL DEFAULT '{}',
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_buyers_phone ON buyers(phone);
CREATE INDEX idx_buyers_name_trgm ON buyers USING gin(name gin_trgm_ops);
```

### Table 5: `cities`

```sql
CREATE TABLE cities (
  code      text PRIMARY KEY,
  name      text NOT NULL UNIQUE,
  active    boolean NOT NULL DEFAULT true,
  timezone  text NOT NULL DEFAULT 'Asia/Kolkata',
  metadata  jsonb NOT NULL DEFAULT '{}'
);

INSERT INTO cities (code, name) VALUES
  ('GG', 'Gurgaon'),
  ('NO', 'Noida'),
  ('GZ', 'Ghaziabad');
```

---

## TIER 2 — Activity / transactional

### Table 6: `visits`

```sql
CREATE TABLE visits (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  visit_code               text UNIQUE,
  buyer_id                 uuid NOT NULL REFERENCES buyers(id),
  broker_id                uuid NOT NULL REFERENCES brokers(id),
  property_id              uuid REFERENCES properties(id),
  society_name             text NOT NULL,
  unit_address_line1       text,
  unit_address_line2       text,
  rm_user_id               uuid REFERENCES users(id),
  source                   text,                   -- 'channel_partner' / 'direct'
  visit_status             text NOT NULL CHECK (visit_status IN ('upcoming','completed','cancelled')),
  selected_at              timestamptz,
  visited_at               timestamptz,

  -- projected from latest followup (updated by trigger)
  current_stage            text NOT NULL DEFAULT 'upcoming',
  current_status           text DEFAULT 'unc',
  latest_followup_id       uuid,
  latest_followup_at       timestamptz,
  latest_followup_note     text,
  next_followup_date       date,
  revisit_date             timestamptz,

  cancelled_reason         text,
  lead_occurrence_count    int DEFAULT 1,
  intent                   jsonb NOT NULL DEFAULT '{}',  -- 6 buyer-intent fields
  metadata                 jsonb NOT NULL DEFAULT '{}',
  lsq_visit_activity_id    text UNIQUE,
  external_ids             jsonb NOT NULL DEFAULT '{}',
  created_at               timestamptz NOT NULL DEFAULT now(),
  updated_at               timestamptz NOT NULL DEFAULT now(),
  created_by               uuid REFERENCES users(id),
  synced_from_sheet_at     timestamptz,
  synced_from_lsq_at       timestamptz
);

CREATE INDEX idx_visits_broker_recent ON visits(broker_id, visited_at DESC);
CREATE INDEX idx_visits_buyer_recent ON visits(buyer_id, visited_at DESC);
CREATE INDEX idx_visits_property ON visits(property_id) WHERE property_id IS NOT NULL;
CREATE INDEX idx_visits_society ON visits(society_name);
CREATE INDEX idx_visits_rm ON visits(rm_user_id, visited_at DESC);
CREATE INDEX idx_visits_stage ON visits(current_stage, visited_at DESC);
CREATE INDEX idx_visits_status ON visits(current_status) WHERE current_stage NOT IN ('booking','ats','not_interested','need_more','cancelled');
CREATE INDEX idx_visits_followup_due ON visits(next_followup_date)
  WHERE current_stage NOT IN ('booking','ats','not_interested','need_more','cancelled');
CREATE INDEX idx_visits_intent_gin ON visits USING gin(intent jsonb_path_ops);
CREATE INDEX idx_visits_meta_gin ON visits USING gin(metadata jsonb_path_ops);
```

### Table 7: `followups` — APPEND-ONLY, partitioned by month

```sql
CREATE TABLE followups (
  id                       uuid NOT NULL DEFAULT gen_random_uuid(),
  visit_id                 uuid NOT NULL REFERENCES visits(id),
  by_user_id               uuid NOT NULL REFERENCES users(id),
  buyer_status             text NOT NULL CHECK (buyer_status IN ('hot','warm','cold','dead','future_prospect','unc')),
  stage                    text NOT NULL,
  note                     text NOT NULL CHECK (length(trim(note)) > 0),  -- mandatory
  next_followup_date       date,
  revisit_date             timestamptz,
  previous_stage           text,
  previous_status          text,
  resolved_nudge_ids       uuid[] NOT NULL DEFAULT '{}',
  is_correction            boolean NOT NULL DEFAULT false,
  lsq_activity_id          text,
  lsq_activity_type        int,
  source                   text NOT NULL DEFAULT 'app',  -- 'app' / 'lsq_sync' / 'manual_import'
  metadata                 jsonb NOT NULL DEFAULT '{}',
  created_at               timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (created_at, id)
) PARTITION BY RANGE (created_at);

-- monthly partitions
CREATE TABLE followups_2026_05 PARTITION OF followups
  FOR VALUES FROM ('2026-05-01') TO ('2026-06-01');
CREATE TABLE followups_2026_06 PARTITION OF followups
  FOR VALUES FROM ('2026-06-01') TO ('2026-07-01');
-- ... pre-create the next 12 partitions; automate via a monthly job

CREATE INDEX idx_followups_visit ON followups(visit_id, created_at DESC);
CREATE INDEX idx_followups_by_user ON followups(by_user_id, created_at DESC);
CREATE INDEX idx_followups_lsq ON followups(lsq_activity_id) WHERE lsq_activity_id IS NOT NULL;

-- Constraint: only allow INSERT, never UPDATE/DELETE (enforced via revoke + RLS)
REVOKE UPDATE, DELETE ON followups FROM PUBLIC;
```

Trigger to project latest followup back onto `visits`:

```sql
CREATE OR REPLACE FUNCTION project_followup_onto_visit() RETURNS trigger AS $$
BEGIN
  UPDATE visits SET
    current_stage         = NEW.stage,
    current_status        = NEW.buyer_status,
    latest_followup_id    = NEW.id,
    latest_followup_at    = NEW.created_at,
    latest_followup_note  = NEW.note,
    next_followup_date    = NEW.next_followup_date,
    revisit_date          = NEW.revisit_date,
    updated_at            = now()
  WHERE id = NEW.visit_id
    AND (latest_followup_at IS NULL OR NEW.created_at > latest_followup_at);
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_project_followup
  AFTER INSERT ON followups
  FOR EACH ROW EXECUTE FUNCTION project_followup_onto_visit();
```

### Table 8: `engagements`

```sql
CREATE TABLE engagements (
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

CREATE INDEX idx_engagements_broker_recent ON engagements(broker_id, created_at DESC);
CREATE INDEX idx_engagements_by_user_recent ON engagements(by_user_id, created_at DESC);
```

### Table 9: `nudges`

```sql
CREATE TABLE nudges (
  id                          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  visit_id                    uuid NOT NULL REFERENCES visits(id),
  from_user_id                uuid NOT NULL REFERENCES users(id),
  to_user_id                  uuid NOT NULL REFERENCES users(id),
  message                     text,
  priority                    text CHECK (priority IN ('low','normal','high')) DEFAULT 'normal',
  resolved_at                 timestamptz,
  resolved_by_followup_id     uuid,
  metadata                    jsonb NOT NULL DEFAULT '{}',
  created_at                  timestamptz NOT NULL DEFAULT now(),
  CHECK (from_user_id != to_user_id)
);

CREATE INDEX idx_nudges_open_to ON nudges(to_user_id, created_at DESC) WHERE resolved_at IS NULL;
CREATE INDEX idx_nudges_visit_open ON nudges(visit_id) WHERE resolved_at IS NULL;
CREATE INDEX idx_nudges_from ON nudges(from_user_id, created_at DESC);
```

### Table 10: `notifications` — partitioned by month

```sql
CREATE TABLE notifications (
  id              bigserial NOT NULL,
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

CREATE TABLE notifications_2026_05 PARTITION OF notifications
  FOR VALUES FROM ('2026-05-01') TO ('2026-06-01');
-- ... pre-create next 12

CREATE INDEX idx_notifs_unread ON notifications(to_user_id, created_at DESC) WHERE read_at IS NULL;
CREATE INDEX idx_notifs_user_recent ON notifications(to_user_id, created_at DESC);
```

---

## TIER 3 — Temporal relationships

### Table 11: `cp_assignments`

```sql
CREATE TABLE cp_assignments (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  broker_id                uuid NOT NULL REFERENCES brokers(id),
  owner_user_id            uuid NOT NULL REFERENCES users(id),
  effective_from           timestamptz NOT NULL DEFAULT now(),
  effective_to             timestamptz,
  assigned_by_user_id      uuid REFERENCES users(id),
  reason                   text,                  -- 'round_robin','manual','bulk_reassign','auto_from_added_by','initial'
  metadata                 jsonb NOT NULL DEFAULT '{}',
  created_at               timestamptz NOT NULL DEFAULT now(),
  CHECK (effective_to IS NULL OR effective_to > effective_from),
  EXCLUDE USING gist (broker_id WITH =, tstzrange(effective_from, effective_to, '[)') WITH &&)
);

CREATE INDEX idx_cp_assn_current ON cp_assignments(broker_id) WHERE effective_to IS NULL;
CREATE INDEX idx_cp_assn_owner_current ON cp_assignments(owner_user_id) WHERE effective_to IS NULL;
CREATE INDEX idx_cp_assn_broker_history ON cp_assignments(broker_id, effective_from DESC);
```

### Table 12: `property_assignments`

```sql
CREATE TABLE property_assignments (
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

CREATE INDEX idx_prop_assn_current ON property_assignments(property_id) WHERE effective_to IS NULL;
CREATE INDEX idx_prop_assn_pm_current ON property_assignments(pm_user_id) WHERE effective_to IS NULL;
```

### Table 13: `tier_assignments`

```sql
CREATE TABLE tier_assignments (
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

CREATE INDEX idx_tier_current ON tier_assignments(broker_id) WHERE effective_to IS NULL;
CREATE INDEX idx_tier_current_t1t2 ON tier_assignments(tier, tier_rank) WHERE effective_to IS NULL AND tier IN ('T1','T2');
```

### Table 14: `user_daily_tasks`

```sql
CREATE TABLE user_daily_tasks (
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
    (kind = 'message' AND message_text IS NOT NULL)
  )
);

CREATE INDEX idx_tasks_user_date ON user_daily_tasks(user_id, task_date DESC);
CREATE INDEX idx_tasks_open ON user_daily_tasks(user_id, task_date) WHERE completed_at IS NULL;
```

---

## TIER 4 — Audit & sync

### Table 15: `events` — partitioned by month

```sql
CREATE TABLE events (
  id                  bigserial NOT NULL,
  event_type          text NOT NULL,
  actor_user_id       uuid REFERENCES users(id),
  entity_type         text NOT NULL,
  entity_id           uuid NOT NULL,
  payload             jsonb NOT NULL,
  before_state        jsonb,
  after_state         jsonb,
  idempotency_key     text,
  correlation_id      text,
  ip_address          inet,
  user_agent          text,
  created_at          timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (created_at, id)
) PARTITION BY RANGE (created_at);

CREATE TABLE events_2026_05 PARTITION OF events
  FOR VALUES FROM ('2026-05-01') TO ('2026-06-01');
-- ... pre-create next 12

CREATE UNIQUE INDEX idx_events_idem ON events(idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE INDEX idx_events_entity ON events(entity_type, entity_id, created_at DESC);
CREATE INDEX idx_events_actor ON events(actor_user_id, created_at DESC);
CREATE INDEX idx_events_type ON events(event_type, created_at DESC);
CREATE INDEX idx_events_corr ON events(correlation_id) WHERE correlation_id IS NOT NULL;

REVOKE UPDATE, DELETE ON events FROM PUBLIC;
```

### Table 16: `sheet_sync_log`

```sql
CREATE TABLE sheet_sync_log (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sheet_name               text NOT NULL,
  sheet_id                 text,
  tab_name                 text,
  run_started_at           timestamptz NOT NULL,
  run_finished_at          timestamptz,
  rows_seen                int DEFAULT 0,
  rows_inserted            int DEFAULT 0,
  rows_updated             int DEFAULT 0,
  rows_skipped             int DEFAULT 0,
  rows_failed              int DEFAULT 0,
  errors                   jsonb NOT NULL DEFAULT '[]',
  status                   text NOT NULL CHECK (status IN ('running','success','failed','partial')),
  triggered_by             text NOT NULL DEFAULT 'cron',
  triggered_by_user_id     uuid REFERENCES users(id),
  metadata                 jsonb NOT NULL DEFAULT '{}'
);

CREATE INDEX idx_sync_log_sheet_time ON sheet_sync_log(sheet_name, run_started_at DESC);
```

### Table 17: `integration_log`

```sql
CREATE TABLE integration_log (
  id                  bigserial PRIMARY KEY,
  direction           text NOT NULL CHECK (direction IN ('inbound','outbound')),
  system              text NOT NULL,
  endpoint            text,
  request_method      text,
  request_body        jsonb,
  request_headers     jsonb,
  response_status     int,
  response_body       jsonb,
  attempt             int NOT NULL DEFAULT 1,
  succeeded           boolean NOT NULL DEFAULT false,
  latency_ms          int,
  correlation_id      text,
  created_at          timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_intlog_system_time ON integration_log(system, created_at DESC);
CREATE INDEX idx_intlog_failures ON integration_log(system, created_at DESC) WHERE succeeded = false;
```

---

## TIER 5 — Configuration

### Table 18: `wa_templates`

```sql
CREATE TABLE wa_templates (
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
  updated_at          timestamptz NOT NULL DEFAULT now(),
  created_by          uuid REFERENCES users(id),
  updated_by          uuid REFERENCES users(id)
);

CREATE INDEX idx_wa_active_order ON wa_templates(order_idx) WHERE active;
```

### Table 19: `system_config`

```sql
CREATE TABLE system_config (
  key           text PRIMARY KEY,
  value         jsonb NOT NULL,
  description   text,
  updated_by    uuid REFERENCES users(id),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

-- seed rows
INSERT INTO system_config (key, value, description) VALUES
  ('stages',
    '["upcoming","avfu","revisit_scheduled","after_revisit_fu","negotiation","booking","ats","future_prospect","not_interested","need_more","cancelled"]'::jsonb,
    'Canonical pipeline stages in display order'),
  ('statuses',
    '["hot","warm","cold","dead","future_prospect","unc"]'::jsonb,
    'Buyer thermal statuses'),
  ('overdue_days', '3'::jsonb, 'Days after next_followup_date past which a visit is overdue'),
  ('round_robin_weights', '{"kam":1.0,"ground":1.2}'::jsonb, 'Weights for CP auto-assignment'),
  ('lsq_sync_interval_minutes', '15'::jsonb, 'How often to poll LSQ for new activities'),
  ('mv_refresh_interval_seconds', '300'::jsonb, 'How often to refresh broker_stats MV');
```

### Table 20: `feature_flags`

```sql
CREATE TABLE feature_flags (
  key             text PRIMARY KEY,
  description     text,
  enabled         boolean NOT NULL DEFAULT false,
  rollout_users   uuid[] DEFAULT '{}',
  rollout_teams   text[] DEFAULT '{}',
  rollout_pct     int CHECK (rollout_pct BETWEEN 0 AND 100),
  metadata        jsonb NOT NULL DEFAULT '{}',
  updated_at      timestamptz NOT NULL DEFAULT now()
);
```

---

## Derived / read projections (materialized views, not in the 20)

### `mv_broker_stats` — refreshed every 5 minutes

```sql
CREATE MATERIALIZED VIEW mv_broker_stats AS
SELECT
  b.id                                                            AS broker_id,
  b.cp_code,
  COUNT(*) FILTER (WHERE v.visited_at > now() - interval '30 days') AS d30_visits,
  COUNT(*) FILTER (WHERE v.visited_at > now() - interval '60 days') AS d60_visits,
  COUNT(*) FILTER (WHERE v.visited_at > now() - interval '90 days') AS d90_visits,
  COUNT(*)                                                         AS all_time_visits,
  MAX(v.visited_at)                                                AS last_visit_at,
  MAX(f.created_at)                                                AS last_followup_at,
  ta.tier                                                          AS current_tier,
  ta.tier_rank,
  ca.owner_user_id                                                 AS current_owner_user_id
FROM brokers b
LEFT JOIN visits v ON v.broker_id = b.id AND v.visit_status = 'completed'
LEFT JOIN followups f ON f.visit_id = v.id
LEFT JOIN tier_assignments ta ON ta.broker_id = b.id AND ta.effective_to IS NULL
LEFT JOIN cp_assignments ca ON ca.broker_id = b.id AND ca.effective_to IS NULL
WHERE b.deleted_at IS NULL
GROUP BY b.id, b.cp_code, ta.tier, ta.tier_rank, ca.owner_user_id;

CREATE UNIQUE INDEX idx_mvbs_broker ON mv_broker_stats(broker_id);
CREATE INDEX idx_mvbs_tier_rank ON mv_broker_stats(current_tier, tier_rank);
CREATE INDEX idx_mvbs_owner ON mv_broker_stats(current_owner_user_id);

-- refresh (use CONCURRENTLY so reads aren't blocked):
-- REFRESH MATERIALIZED VIEW CONCURRENTLY mv_broker_stats;
```

### `mv_user_dashboard` — refreshed every 1 minute

```sql
CREATE MATERIALIZED VIEW mv_user_dashboard AS
SELECT
  u.id                                            AS user_id,
  COUNT(DISTINCT n.id) FILTER (WHERE n.read_at IS NULL)
                                                  AS unread_notif_count,
  COUNT(DISTINCT nu.id) FILTER (WHERE nu.resolved_at IS NULL)
                                                  AS open_nudge_count,
  COUNT(DISTINCT t.id) FILTER (WHERE t.task_date = current_date AND t.completed_at IS NULL)
                                                  AS open_task_count
FROM users u
LEFT JOIN notifications n ON n.to_user_id = u.id
LEFT JOIN nudges nu ON nu.to_user_id = u.id
LEFT JOIN user_daily_tasks t ON t.user_id = u.id
WHERE u.active
GROUP BY u.id;

CREATE UNIQUE INDEX idx_mvud_user ON mv_user_dashboard(user_id);
```

---

## Row Level Security — implementing the permissions matrix

```sql
ALTER TABLE visits ENABLE ROW LEVEL SECURITY;
ALTER TABLE brokers ENABLE ROW LEVEL SECURITY;
ALTER TABLE properties ENABLE ROW LEVEL SECURITY;
ALTER TABLE followups ENABLE ROW LEVEL SECURITY;
ALTER TABLE engagements ENABLE ROW LEVEL SECURITY;
ALTER TABLE nudges ENABLE ROW LEVEL SECURITY;

-- helper: who is the current request user?
-- set by the API layer:  SET LOCAL "app.current_user_id" = '<uuid>';

CREATE OR REPLACE FUNCTION current_app_user_id() RETURNS uuid AS $$
  SELECT NULLIF(current_setting('app.current_user_id', true), '')::uuid;
$$ LANGUAGE sql STABLE;

CREATE OR REPLACE FUNCTION current_app_user_team() RETURNS text AS $$
  SELECT team FROM users WHERE id = current_app_user_id();
$$ LANGUAGE sql STABLE;

CREATE OR REPLACE FUNCTION current_app_user_cities() RETURNS text[] AS $$
  SELECT cities FROM users WHERE id = current_app_user_id();
$$ LANGUAGE sql STABLE;

-- visits: admin sees all; TL sees their cities; KAM sees own CPs;
--         Ground sees own CPs + visits at their assigned properties
CREATE POLICY visits_read ON visits FOR SELECT USING (
  current_app_user_team() = 'Admin'
  OR (
    current_app_user_team() = 'TL'
    AND visits.society_name IN (
      SELECT p.society_name FROM properties p
      WHERE p.city = ANY(current_app_user_cities())
    )
  )
  OR (
    current_app_user_team() = 'KAM'
    AND visits.broker_id IN (
      SELECT broker_id FROM cp_assignments
      WHERE owner_user_id = current_app_user_id() AND effective_to IS NULL
    )
  )
  OR (
    current_app_user_team() = 'Ground'
    AND (
      visits.broker_id IN (
        SELECT broker_id FROM cp_assignments
        WHERE owner_user_id = current_app_user_id() AND effective_to IS NULL
      )
      OR visits.property_id IN (
        SELECT property_id FROM property_assignments
        WHERE pm_user_id = current_app_user_id() AND effective_to IS NULL
      )
    )
  )
);

-- followups insert: KAM/Ground can only insert on visits they can see;
-- TL/Admin can insert on any
CREATE POLICY followups_insert ON followups FOR INSERT WITH CHECK (
  current_app_user_team() IN ('Admin','TL')
  OR visit_id IN (SELECT id FROM visits)  -- RLS on visits already filters
);
```

---

## Indexes summary — what gets hit by each main view

| View / query | Index used |
|---|---|
| Visit list (by RM, recent first) | `idx_visits_rm` |
| Visit list (filtered by stage) | `idx_visits_stage` |
| Open followups due today | `idx_visits_followup_due` |
| CP list (by tier + rank) | `idx_mvbs_tier_rank` on `mv_broker_stats` |
| CP popup (their visits) | `idx_visits_broker_recent` |
| Property popup (visits at this property) | `idx_visits_property` + `idx_visits_society` |
| Broker search ("Aman R") | `idx_brokers_name_trgm` |
| Unread notifications count | `idx_notifs_unread` |
| Open nudges to me | `idx_nudges_open_to` |
| Daily call list | `idx_tasks_user_date` |
| Buyer cross-property history | `idx_visits_buyer_recent` |

---

## Backup & recovery

- **Neon PITR**: 30 days built-in
- **Daily logical backup**: `pg_dump --schema-only` + `pg_dump --data-only` to S3 weekly
- **Disaster drill**: Quarterly — restore a backup into a fresh Neon branch and verify all 20 tables + materialized views

---

## Compliance notes

- `buyers.phone`, `brokers.phone` are PII under DPDP (India). Encrypt at rest via Neon's column-level encryption or pgsodium.
- Logs must scrub PII — the `integration_log.request_body` and `response_body` columns should redact phone-number patterns before insert (use a Postgres function on the INSERT).
- 7-year retention requirement for financial records (booking, ATS) — events older than 7 years can be deleted, not before.
