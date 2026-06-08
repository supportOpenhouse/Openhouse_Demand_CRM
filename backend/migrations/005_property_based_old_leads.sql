-- ============================================================================
-- 005 · Old-lead is now PROPERTY-STATUS based (replaces the pre-1-May date rule)
-- ============================================================================
-- Context / new rule (per product owner):
--   * A visit is "active" (worked in the main Visits list) ONLY if its unit is
--     still live inventory — i.e. it maps (by home_id) to an `all_properties`
--     row whose listing_status is 'Ready' or 'Coming Soon'.
--   * Every other visit — unit is Sold / Archived / Booked, OR has no listing
--     record at all — moves to OLD LEADS and is marked Buyer Status = 'dead'
--     (lead_status + current_status) so it doesn't clutter the working set.
--   * This REPLACES migration 003's date rule (visit_date < 2026-05-01 AND
--     never actioned). The date rule is gone.
--
-- Persistence: `is_old_lead` was a STORED generated column (can't reference
-- another table), so step 1 converts it to a normal, updatable boolean. The
-- 15-min sync re-derives this every run via sheet_sync.sync_inactive_leads(),
-- which runs AFTER the visit upsert so the sheet can't resurrect a dead lead.
-- Idempotent — safe to re-run.
-- ============================================================================

-- 1. make is_old_lead a normal column (drop the generated date expression)
ALTER TABLE visits ALTER COLUMN is_old_lead DROP EXPRESSION IF EXISTS;
ALTER TABLE visits ALTER COLUMN is_old_lead SET DEFAULT FALSE;

-- 2. one-time backfill — classify every visit by its unit's current status in
--    all_properties (home_id join). bool_or guards against a unit appearing
--    under more than one status row (a relisted unit counts as active).
WITH cls AS (
  SELECT v.id,
         bool_or(ap.listing_status IN ('Ready','Coming Soon')) AS active
  FROM visits v
  LEFT JOIN all_properties ap
    ON ap.home_id = v.home_id AND ap.deleted_at IS NULL
  GROUP BY v.id
)
UPDATE visits v SET
  is_old_lead        = NOT COALESCE(cls.active, FALSE),
  lead_status        = CASE WHEN COALESCE(cls.active, FALSE) THEN v.lead_status        ELSE 'dead' END,
  current_status     = CASE WHEN COALESCE(cls.active, FALSE) THEN v.current_status     ELSE 'dead' END,
  -- dead leads carry no pending followup obligation (keeps them out of FU-due lists)
  next_followup_date = CASE WHEN COALESCE(cls.active, FALSE) THEN v.next_followup_date ELSE NULL END,
  revisit_date       = CASE WHEN COALESCE(cls.active, FALSE) THEN v.revisit_date       ELSE NULL END,
  updated_at         = now()
FROM cls
WHERE cls.id = v.id;
