-- ============================================================================
-- 006 · Engagement call-disposition + follow-up (2026-06-08)
-- ============================================================================
-- Adds the Close/HubSpot "2-axis" activity model to engagements:
--   connected     — the call result: connected | no_answer | busy | switched_off | wrong_number
--   outcome       — the disposition, set only when connected:
--                   interested | bringing_buyer | not_interested | callback_requested | no_inventory_match
--   followup_date — an optional next-action date scheduled at log time.
-- Idempotent: ADD COLUMN IF NOT EXISTS.
-- ============================================================================

ALTER TABLE engagements
  ADD COLUMN IF NOT EXISTS connected     text,
  ADD COLUMN IF NOT EXISTS outcome       text,
  ADD COLUMN IF NOT EXISTS followup_date date;

-- surface open engagement follow-ups quickly (Overdue / Today / Upcoming views)
CREATE INDEX IF NOT EXISTS idx_engagements_followup ON engagements(followup_date) WHERE followup_date IS NOT NULL;
