-- ============================================================================
-- 018 · Negotiation outcome (did the meeting happen?) + booking-received date
-- ============================================================================
-- Captures, from the new Negotiations tab:
--   • negotiation_happened  — did the scheduled negotiation meeting take place?
--   • booking_received_date — the date a booking was received.
-- Mirrors migration 007 (negotiation_date): a new column on the append-only,
-- partitioned `followups` parent (cascades to all partitions) is projected onto
-- the `visits` row by the last-wins trigger.
--
-- PURELY ADDITIVE — existing rows are untouched (both columns default NULL), and
-- nothing changes behaviourally until the app starts writing them. Nullable, no
-- default → metadata-only ALTER (instant, no table rewrite). Idempotent.
-- ============================================================================

-- 1. new columns on the append-only followups table (cascades to partitions)
ALTER TABLE followups ADD COLUMN IF NOT EXISTS negotiation_happened  boolean;
ALTER TABLE followups ADD COLUMN IF NOT EXISTS booking_received_date date;

-- 2. projected onto the visit (last-wins, same as negotiation_date)
ALTER TABLE visits    ADD COLUMN IF NOT EXISTS negotiation_happened  boolean;
ALTER TABLE visits    ADD COLUMN IF NOT EXISTS booking_received_date date;

-- 3. extend the projection trigger to also carry the two new columns onto the
--    visit. The trigger body is CUMULATIVE — every projected column must be
--    listed — so this reproduces the full body from migration 007 VERBATIM and
--    appends only the two new assignments.
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
    negotiation_happened  = NEW.negotiation_happened,
    booking_received_date = NEW.booking_received_date,
    updated_at            = now()
  WHERE id = NEW.visit_id
    AND (latest_followup_at IS NULL OR NEW.created_at > latest_followup_at);
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
