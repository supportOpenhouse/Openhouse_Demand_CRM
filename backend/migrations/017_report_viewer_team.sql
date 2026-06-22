-- 017_report_viewer_team.sql
-- Report-only access tier (e.g. the supply team).
--
-- A `Report` user can use the Report Share feature and browse the live property
-- list to generate seller reports, but has NO other CRM access. This is enforced
-- deny-by-default: 'Report' != 'Admin', so every _require_admin / _require_admin_or_tl
-- route already 403s for them, and seed_snapshot.scope_for_user returns a
-- properties-only snapshot (no leads, brokers, visits, queues or notifications).
--
-- Only two things are GRANTED to the team: the two POST /api/reports/property*
-- endpoints (via _require_report_access) and the property list in the seed.
--
-- Idempotent: drops the inline CHECK from migration 001 (auto-named users_team_check)
-- and re-adds it with 'Report' included.

ALTER TABLE users DROP CONSTRAINT IF EXISTS users_team_check;
ALTER TABLE users ADD  CONSTRAINT users_team_check
  CHECK (team IN ('Admin','TL','KAM','Ground','Report'));
