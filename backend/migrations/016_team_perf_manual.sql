-- ============================================================================
-- 016 · team_perf_manual — admin-entered cells for the Team Performance report
-- ============================================================================
-- The Team Performance tables compute most columns from live data (read-only),
-- but a few have no backing data and are filled in by hand: Engagement Meetings,
-- Total Dialled, Connected %, Sales pending L1/L2/L3. We store those per
-- (person, metric) so an admin's entry persists. Backend-computed columns are
-- NOT stored here — they are always derived fresh, so admins can't edit them.
--
-- Mirrors the kh_overrides design (small, isolated, idempotent). Values are kept
-- as free text (e.g. "12" or "85%") — they are display figures, not aggregated.
-- ============================================================================

CREATE TABLE IF NOT EXISTS team_perf_manual (
  person_slug   text        NOT NULL,   -- users.slug the row belongs to
  metric_key    text        NOT NULL,   -- e.g. engagement_meetings, total_dialled, connected_pct, sales_pending_l1
  value         text,                   -- free-text display value ('' / NULL clears it)
  updated_by    text,                   -- admin slug who set it
  updated_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (person_slug, metric_key)
);
