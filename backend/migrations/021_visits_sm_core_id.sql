-- Identity for the visit's RM, from the source system (oh_salesmanager.id).
-- Lets scoping distinguish two users with the SAME display name (e.g. the two
-- "Ankit Kumar"s). Populated by sync_visits from the visitors sheet's
-- sales_manager_id column (with a one-shot backfill from core for old rows);
-- COALESCE in the upsert means a sheet without the column never NULLs it.
ALTER TABLE visits ADD COLUMN IF NOT EXISTS sales_manager_core_id bigint;
