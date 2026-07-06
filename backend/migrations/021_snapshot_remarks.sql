-- Per-unit manual remark shown in the Inventory Snapshot and included in the
-- snapshot shared with channel partners. Added/edited by Admin/TL from the
-- Inventory Snapshot tab, keyed by the unit's oh-core home_id. Deliberately a
-- SEPARATE table from property_review_fields (migration 019) — the snapshot
-- remark is a different concern from the Property-Status "Demand team remark",
-- so the two never collide. Additive + isolated: touches no existing table or
-- data. GET /api/snapshot-remarks reads it (degrades to {} if absent);
-- POST /api/snapshot-remark writes it.
CREATE TABLE IF NOT EXISTS snapshot_remarks (
  home_id     text        PRIMARY KEY,
  remark      text,
  set_by      text,
  updated_at  timestamptz NOT NULL DEFAULT now()
);
