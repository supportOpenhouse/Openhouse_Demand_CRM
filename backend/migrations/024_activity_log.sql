-- 024 · Activity log — one line per action, by a person or by the system (Akshit, Oct 2026).
-- Who did what, to which lead / CP / unit / user, the old -> new values, and when.
-- Written by api/activity.py in the SAME transaction as the change it describes.
-- Append-only: the triggers below refuse UPDATE, DELETE and TRUNCATE, so history
-- cannot be edited or erased by accident (even with the owner login). Additive only;
-- safe to re-run. Admin-only to read (GET /api/activity).

CREATE TABLE IF NOT EXISTS activity_log (
  id             bigserial PRIMARY KEY,
  at             timestamptz NOT NULL DEFAULT now(),
  source         text NOT NULL DEFAULT 'app',   -- app | sync | system | script | backfill
  actor_user_id  uuid,                          -- NULL for the sync / system
  actor_slug     text,
  actor_name     text,
  actor_team     text,
  actor_role     text,
  action         text NOT NULL,                 -- e.g. followup.add, user.update, export.analytics_csv
  object_type    text,                          -- visit | cp | property | user | society | report | ...
  object_id      text,
  object_label   text,                          -- human label at the time ("D-601, ROF Ananda")
  changes        jsonb,                         -- {"field": {"old": ..., "new": ...}}
  details        jsonb,                         -- everything else about the action
  ip             text,
  user_agent     text,
  http_path      text
);

CREATE INDEX IF NOT EXISTS activity_log_at_idx     ON activity_log (at DESC, id DESC);
CREATE INDEX IF NOT EXISTS activity_log_actor_idx  ON activity_log (actor_user_id, at DESC);
CREATE INDEX IF NOT EXISTS activity_log_object_idx ON activity_log (object_type, object_id, at DESC);
CREATE INDEX IF NOT EXISTS activity_log_action_idx ON activity_log (action, at DESC);

CREATE OR REPLACE FUNCTION activity_log_append_only() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'activity_log is append-only: % is not allowed', TG_OP;
END $$;

DROP TRIGGER IF EXISTS trg_activity_log_no_change ON activity_log;
CREATE TRIGGER trg_activity_log_no_change
  BEFORE UPDATE OR DELETE ON activity_log
  FOR EACH ROW EXECUTE FUNCTION activity_log_append_only();

DROP TRIGGER IF EXISTS trg_activity_log_no_truncate ON activity_log;
CREATE TRIGGER trg_activity_log_no_truncate
  BEFORE TRUNCATE ON activity_log
  FOR EACH STATEMENT EXECUTE FUNCTION activity_log_append_only();
