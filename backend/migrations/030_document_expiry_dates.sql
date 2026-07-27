ALTER TABLE honeymoon_documents ADD COLUMN IF NOT EXISTS expires_on DATE;
CREATE INDEX IF NOT EXISTS honeymoon_documents_expiry_idx ON honeymoon_documents (wedding_id, expires_on) WHERE archived_at IS NULL AND expires_on IS NOT NULL;
