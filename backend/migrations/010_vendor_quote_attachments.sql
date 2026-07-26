CREATE TABLE IF NOT EXISTS vendor_quote_attachments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  quote_id UUID NOT NULL REFERENCES vendor_quotes(id) ON DELETE CASCADE,
  wedding_id UUID NOT NULL REFERENCES weddings(id) ON DELETE CASCADE,
  original_name TEXT NOT NULL,
  storage_key TEXT NOT NULL UNIQUE,
  content_type TEXT NOT NULL,
  byte_size INTEGER NOT NULL CHECK (byte_size >= 0),
  checksum_sha256 TEXT NOT NULL,
  created_by UUID NOT NULL REFERENCES users(id),
  archived_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS vendor_quote_attachments_active_idx ON vendor_quote_attachments (quote_id, created_at) WHERE archived_at IS NULL;
