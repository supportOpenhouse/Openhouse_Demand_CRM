-- ============================================================================
-- 008 · users.core_sales_manager_id — Core app SalesManager.id per CRM user
-- ============================================================================
-- For the CRM→Core visit-booking flow (docs/CRM_VISIT_BOOKING_GUIDE.md): the
-- schedule-visits / buyer Core APIs require a `sales_manager_id` (Core integer)
-- identifying who booked. We store it per CRM user so the booking endpoint can
-- resolve it from the logged-in RM.
--
-- Source: the inventory spreadsheet's "Sales managers" tab (sales_manager_id +
-- sales_manager_phone + sales_manager_name). Matched to users by PHONE
-- (last-10 digits), with an unambiguous-name fallback for users with no phone
-- on file (e.g. Akshit). sheet_sync.sync_sales_manager_ids() keeps it current.
-- Idempotent.
-- ============================================================================

ALTER TABLE users ADD COLUMN IF NOT EXISTS core_sales_manager_id integer;
COMMENT ON COLUMN users.core_sales_manager_id IS
  'Core app SalesManager.id (who a CRM-booked visit is attributed to). Synced from the "Sales managers" inventory tab by phone, name fallback.';
