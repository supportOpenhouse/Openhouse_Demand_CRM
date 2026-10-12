-- 023 · Daily Sales Report (DSR) settings: area targets by month, area -> manager,
-- PM -> manager, and an append-only change log. Additive only; safe to re-run.
-- Until this runs, api/dsr.py falls back to the built-in October 2026 defaults
-- and the settings PUT endpoints return 409.

CREATE TABLE IF NOT EXISTS dsr_area_targets (
  month       text NOT NULL,                 -- 'YYYY-MM'
  city        text,
  area        text NOT NULL,
  target      numeric,
  updated_by  uuid REFERENCES users(id),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (month, area)
);

CREATE TABLE IF NOT EXISTS dsr_area_managers (
  area             text PRIMARY KEY,
  manager_user_id  uuid REFERENCES users(id),
  updated_by       uuid REFERENCES users(id),
  updated_at       timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS dsr_pm_managers (
  pm_user_id       uuid PRIMARY KEY REFERENCES users(id),
  manager_user_id  uuid REFERENCES users(id),
  updated_by       uuid REFERENCES users(id),
  updated_at       timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS dsr_change_log (
  id          serial PRIMARY KEY,
  at          timestamptz NOT NULL DEFAULT now(),
  by_user_id  uuid REFERENCES users(id),
  kind        text NOT NULL,                 -- target / area_manager / pm_manager
  key         text NOT NULL,
  old_value   text,
  new_value   text
);

-- Seed: October 2026 area targets (total 100).
INSERT INTO dsr_area_targets (month, city, area, target) VALUES
  ('2026-10', 'Gurgaon',   'Dwarka Expressway',   10),
  ('2026-10', 'Gurgaon',   'New Gurgaon 2',       10),
  ('2026-10', 'Gurgaon',   'New Gurgaon 1',       10),
  ('2026-10', 'Gurgaon',   'SPR',                  4),
  ('2026-10', 'Noida',     'Noida Extension',     23),
  ('2026-10', 'Noida',     'Central Noida',        8),
  ('2026-10', 'Noida',     'Noida Expressway',     7),
  ('2026-10', 'Noida',     'Greater Noida',        6),
  ('2026-10', 'Ghaziabad', 'Raj Nagar Extension', 10),
  ('2026-10', 'Ghaziabad', 'Crossings Republik',   6),
  ('2026-10', 'Ghaziabad', 'NH24',                 6)
ON CONFLICT DO NOTHING;

-- Seed: area managers, resolved by exact active user name.
INSERT INTO dsr_area_managers (area, manager_user_id)
SELECT m.area, (SELECT u.id FROM users u WHERE u.name = m.mgr AND u.active ORDER BY u.created_at LIMIT 1)
  FROM (VALUES
    ('Dwarka Expressway', 'Ayush Ojha'), ('New Gurgaon 2', 'Ayush Ojha'),
    ('New Gurgaon 1', 'Puran Kiraula'), ('SPR', 'Puran Kiraula'),
    ('Noida Extension', 'Ajitesh Singh'),
    ('Noida Expressway', 'Amar'), ('Greater Noida', 'Amar'),
    ('Raj Nagar Extension', 'Aditya Bhasker'),
    ('Central Noida', 'Manish Pal'), ('Crossings Republik', 'Manish Pal'), ('NH24', 'Manish Pal')
  ) AS m(area, mgr)
ON CONFLICT DO NOTHING;
