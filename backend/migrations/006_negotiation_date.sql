-- ============================================================================
-- 006 · Negotiation meeting date + "After Negotiation FU" stage
-- ============================================================================
-- Mirrors the Revisit Scheduled flow: when a follow-up is logged with stage
-- 'negotiation', the user schedules a negotiation-meeting date & time. We store
-- it on followups + project it onto visits, so the Visits "Next Activity" column
-- can show it and the stage auto-moves to 'after_negotiation_fu' once it passes.
-- Idempotent.
-- ============================================================================

-- 1. new column on the append-only followups table (cascades to partitions)
ALTER TABLE followups ADD COLUMN IF NOT EXISTS negotiation_date timestamptz;

-- 2. projected onto the visit (last-wins, same as revisit_date)
ALTER TABLE visits ADD COLUMN IF NOT EXISTS negotiation_date timestamptz;

-- 3. extend the projection trigger to also carry negotiation_date onto the visit
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
    negotiation_date      = NEW.negotiation_date,
    updated_at            = now()
  WHERE id = NEW.visit_id
    AND (latest_followup_at IS NULL OR NEW.created_at > latest_followup_at);
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
