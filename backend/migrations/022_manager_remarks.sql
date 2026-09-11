-- Manager remarks on a visit: "did the manager call?" + a note, kept as a RUNNING
-- HISTORY (never overwritten) alongside the PM follow-up remarks. Written only by
-- TL/Admin (enforced in the API, see main.py add_manager_remark).
--
-- Keyed by visit_code (the core visit id, the same key `visits.visit_code` uses and
-- the one the frontend knows) rather than visits.id, so a visit row rebuilt by the
-- sheet sync can never orphan a remark.
CREATE TABLE IF NOT EXISTS visit_manager_remarks (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  visit_code  text NOT NULL,
  by_user_id  uuid NOT NULL REFERENCES users(id),
  called      boolean NOT NULL,
  note        text NOT NULL DEFAULT '',
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_vmr_visit_code ON visit_manager_remarks (visit_code, created_at DESC);
