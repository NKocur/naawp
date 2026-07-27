ALTER TABLE honeymoon_packing_items ADD COLUMN IF NOT EXISTS due_on DATE;
CREATE INDEX IF NOT EXISTS honeymoon_packing_due_idx ON honeymoon_packing_items (wedding_id, due_on) WHERE archived_at IS NULL AND due_on IS NOT NULL;
