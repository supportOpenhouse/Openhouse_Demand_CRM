-- ============================================================================
-- 011 · Old-lead RECENCY/ACTIVITY guard (fixes fresh leads landing in Old Leads)
-- ============================================================================
-- Problem with migration 005's rule: a visit was archived to Old Leads + forced
-- Dead the instant its unit stopped being 'Ready'/'Coming Soon', with NO recency
-- check. So a visit made *yesterday* on a unit that just turned 'Booked'/'Sold'
-- was wiped (lead_status/current_status→'dead', next_followup_date/revisit_date
-- →NULL) every 15 min. ~240 visits dated within 30 days were mis-filed this way;
-- 396 of them had real follow-up history that the force-dead destroyed.
--
-- New rule (matches sheet_sync.sync_inactive_leads): a visit is ACTIVE if ANY of
--   • unit live (Ready/Coming Soon in `properties` OR `all_properties`), OR
--   • RECENT — visited within 60 days, OR
--   • ACTIONED — a follow-up was logged (latest_followup_at not null), OR
--   • in an ACTIVE stage (negotiation/booking/ATS/revisit/need-more).
-- Only a dead-unit lead that is >60d old, never actioned, and not in flight is Old.
--
-- IMPORTANT: deploy the backend (sheet_sync.py) FIRST. The 15-min sync re-derives
-- this; running this migration while the OLD code is live would be undone next sync.
--
-- Idempotent. MUST run inside a single transaction (temp table is ON COMMIT DROP).
-- Three steps:
--   1. reclassify is_old_lead / dead with the guard.
--   2. REPAIR actioned leads: re-project each one's latest follow-up (the append-only
--      `followups` table is the untouched source of truth) to restore the lead_status
--      / stage / next_followup_date / revisit_date the old rule wiped.
--   3. NEUTRALISE un-actioned residue: a never-actioned lead returning to Active still
--      carries the old forced 'dead'. Reset it to 'Not Updated'; the next sheet sync
--      fills the real buyer status from the Visitors sheet (it owns un-actioned rows).
-- ============================================================================

DROP TABLE IF EXISTS _recls;
CREATE TEMP TABLE _recls ON COMMIT DROP AS
WITH live AS (
  SELECT v.id,
         ( bool_or(p.listing_status  IN ('Ready','Coming Soon'))
        OR bool_or(ap.listing_status IN ('Ready','Coming Soon')) ) AS live_unit
  FROM visits v
  LEFT JOIN properties     p  ON p.home_id  = v.home_id AND p.deleted_at  IS NULL
  LEFT JOIN all_properties ap ON ap.home_id = v.home_id AND ap.deleted_at IS NULL
  GROUP BY v.id
)
SELECT v.id,
       v.is_old_lead AS was_old,
       v.latest_followup_at,
       ( COALESCE(l.live_unit, FALSE)
      OR (v.visit_date IS NOT NULL AND v.visit_date >= current_date - 60)
      OR v.latest_followup_at IS NOT NULL
      OR v.current_stage = ANY(ARRAY['negotiation','after_negotiation_fu',
           'booking','ats','revisit_scheduled','after_revisit_fu','need_more']) ) AS active
FROM visits v
JOIN live l ON l.id = v.id;

-- 1. reclassify (mirrors sheet_sync.sync_inactive_leads) ----------------------
UPDATE visits v SET
  is_old_lead        = NOT r.active,
  lead_status        = CASE WHEN r.active THEN v.lead_status        ELSE 'dead' END,
  current_status     = CASE WHEN r.active THEN v.current_status     ELSE 'dead' END,
  next_followup_date = CASE WHEN r.active THEN v.next_followup_date ELSE NULL END,
  revisit_date       = CASE WHEN r.active THEN v.revisit_date       ELSE NULL END,
  updated_at         = now()
FROM _recls r
WHERE r.id = v.id
  AND ( v.is_old_lead IS DISTINCT FROM (NOT r.active)
        OR (NOT r.active
            AND (v.lead_status <> 'dead' OR v.current_status <> 'dead'
                 OR v.next_followup_date IS NOT NULL OR v.revisit_date IS NOT NULL)) );

-- 2. repair the force-deaded ACTIONED leads — re-project their latest follow-up,
--    exactly as trg_project_followup would (migration 007). No-op if already in sync.
WITH latest AS (
  SELECT DISTINCT ON (f.visit_id)
         f.visit_id, f.id, f.buyer_status, f.stage, f.note,
         f.created_at, f.next_followup_date, f.revisit_date, f.negotiation_date
  FROM followups f
  ORDER BY f.visit_id, f.created_at DESC
)
UPDATE visits v SET
  lead_status          = CASE WHEN l.buyer_status = 'unc' THEN 'select_status' ELSE l.buyer_status END,
  current_stage        = l.stage,
  current_status       = l.buyer_status,
  latest_followup_id   = l.id,
  latest_followup_at   = l.created_at,
  latest_followup_date = l.created_at::date,
  latest_followup_note = l.note,
  next_followup_date   = l.next_followup_date,
  revisit_date         = l.revisit_date,
  negotiation_date     = l.negotiation_date,
  updated_at           = now()
FROM latest l
WHERE l.visit_id = v.id
  AND v.is_old_lead = FALSE
  AND v.latest_followup_at IS NOT NULL
  AND ( v.lead_status  IS DISTINCT FROM (CASE WHEN l.buyer_status = 'unc' THEN 'select_status' ELSE l.buyer_status END)
     OR v.current_stage IS DISTINCT FROM l.stage
     OR v.next_followup_date IS DISTINCT FROM l.next_followup_date
     OR v.revisit_date       IS DISTINCT FROM l.revisit_date
     OR v.negotiation_date   IS DISTINCT FROM l.negotiation_date );

-- 3. neutralise force-dead residue on UN-ACTIONED leads now returning to Active.
--    Reset to 'Not Updated'; the next sheet sync restores the real buyer status from
--    the Visitors sheet (sync_visits overwrites lead_status when latest_followup_at IS
--    NULL). Scoped to leads that WERE old and have no follow-up — never touches a lead
--    the team set in-app.
UPDATE visits v SET
  lead_status    = 'select_status',
  current_status = 'unc',
  updated_at     = now()
FROM _recls r
WHERE r.id = v.id
  AND r.was_old
  AND r.active
  AND r.latest_followup_at IS NULL
  AND (v.lead_status = 'dead' OR v.current_status = 'dead');
