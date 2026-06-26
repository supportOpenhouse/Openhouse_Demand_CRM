-- Manual review fields edited inline in the Property Status report (Property
-- Performance tab) by Admin/TL: "Ongoing offer" + "Demand team remark", keyed by
-- the unit's oh-core home_id. Mirrors kh_overrides (migration 014). Additive +
-- isolated — touches no existing table or data. GET /api/key-handovers reads it
-- (degrades gracefully if absent); POST /api/property-review writes it.
CREATE TABLE IF NOT EXISTS property_review_fields (
  home_id            text        PRIMARY KEY,
  society_name       text,
  unit_no            text,
  ongoing_offer      text,
  demand_team_remark text,
  set_by             text,
  updated_at         timestamptz NOT NULL DEFAULT now()
);
