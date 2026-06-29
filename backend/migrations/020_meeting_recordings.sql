-- 020_meeting_recordings.sql
-- Read-only annotation layer: a glanceable "🎙 meeting recorded" note (date + who
-- conducted it) surfaced against CRM brokers (engagements) and, where a real visit
-- id exists, against a specific follow-up. Sourced from the Openhouse Meetings app
-- DB (MEETINGS_DATABASE_URL) by meetings_sync.run_sync(), which reads that DB
-- READ-ONLY and writes ONLY this table.
--
-- Safe by construction:
--   * brand-new table (CREATE TABLE IF NOT EXISTS) — alters nothing existing.
--   * join keys are TEXT (cp_code, visit_code) with NO foreign keys, so the
--     15-min visits/brokers re-sync can never cascade or lock through this table.
--   * with MEETINGS_DATABASE_URL unset the sync is a no-op and this table stays
--     empty; nothing else in the app depends on it being populated.
--
-- Idempotent: CREATE TABLE / INDEX IF NOT EXISTS. Manual deploy (only 001 runs in
-- bootstrap). Re-applying is a no-op.

CREATE TABLE IF NOT EXISTS meeting_recordings (
  meeting_id     uuid PRIMARY KEY,                  -- meetings.id from the Meetings app (stable natural key)
  meeting_type   text NOT NULL,                     -- 'engagement' | 'visit'
  meeting_date   timestamptz,                       -- meetings.started_at
  rm_name        text,                              -- who conducted it (Meetings users.name)
  rm_smid        integer,                           -- Meetings users.smid (Core sales_manager_id), for reference

  -- raw CP identity carried by the recording (for display + the admin match queue)
  cp_code        text,
  cp_name        text,
  cp_mobile      text,
  cp_visit_id    text,                              -- source-sheet visit id, when the meeting carried one

  -- resolved CRM anchors (TEXT, NO FK). NULL until/unless resolved.
  broker_cp_code text,                              -- = a real brokers.cp_code (drives CP-card / BrokerModal chips)
  visit_code     text,                              -- = a real visits.visit_code (drives the per-follow-up chip)

  match_status   text NOT NULL DEFAULT 'unmatched', -- 'unmatched' | 'matched' | 'manual'
  match_method   text,                              -- 'cp_code' | 'cp_mobile' | 'cp_visit_id' | 'manual' | NULL
  matched_by     uuid,                              -- CRM users.id for a manual match (NO FK by design)
  matched_at     timestamptz,

  summary        jsonb,                             -- structured Claude summary (rendered defensively; no transcript)
  status         text,                              -- meetings.status (we only sync 'ready')

  synced_at      timestamptz NOT NULL DEFAULT now(),
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);

-- Lookups the seed/scoping + admin queue need (partial = small + write-cheap).
CREATE INDEX IF NOT EXISTS idx_meeting_rec_cp        ON meeting_recordings(broker_cp_code) WHERE broker_cp_code IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_meeting_rec_visit     ON meeting_recordings(visit_code)     WHERE visit_code IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_meeting_rec_unmatched ON meeting_recordings(match_status)   WHERE match_status = 'unmatched';
