-- The weddings table already contains the shared name, date, and location fields.
-- This migration records that those settings are now maintained through the workspace API.
CREATE INDEX IF NOT EXISTS weddings_created_by_idx ON weddings (created_by);
