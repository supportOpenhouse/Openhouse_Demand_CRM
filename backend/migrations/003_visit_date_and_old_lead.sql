-- ============================================================================
-- 003 · Normalize visit_date + persisted old-lead flag
-- ============================================================================
-- Context:
--  * ~1,536 visits have a blank visit_date but a valid selected_date. The sheet
--    sync resets visit_date from the (blank) sheet cell every 15 min, so a one-off
--    backfill alone wouldn't hold — sheet_sync.py now COALESCEs visit_date to
--    selected_date on every sync. This UPDATE fixes the existing rows once.
--  * "Old lead" was only computed in the frontend. We persist it here as
--    "old (pre-1-May) AND never actioned in the app" (latest_followup_at IS NULL).
-- Idempotent.
-- ============================================================================

-- 1. one-time backfill (the sync keeps it filled going forward)
UPDATE visits
   SET visit_date = selected_date
 WHERE visit_date IS NULL
   AND selected_date IS NOT NULL;

-- 2. persisted old-lead flag (STORED generated column; recomputes when
--    visit_date / latest_followup_at change). Old + never actioned.
ALTER TABLE visits
  ADD COLUMN IF NOT EXISTS is_old_lead boolean
  GENERATED ALWAYS AS (
    visit_date < DATE '2026-05-01' AND latest_followup_at IS NULL
  ) STORED;
