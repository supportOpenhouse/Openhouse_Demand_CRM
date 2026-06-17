-- Manual key-handover overrides. Admins can edit the KH date directly in the
-- Property Status report; the value is recorded here and ALWAYS wins over the
-- matched (sheet_key_handovers / acquisitions) KH date. Keyed by the unit's
-- oh-core home_id. Additive + isolated — touches no existing table or data.
CREATE TABLE IF NOT EXISTS kh_overrides (
  home_id           text        PRIMARY KEY,
  society_name      text,
  unit_no           text,
  key_handover_date date,
  set_by            text,
  updated_at        timestamptz NOT NULL DEFAULT now()
);
