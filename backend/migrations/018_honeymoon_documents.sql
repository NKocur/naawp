CREATE TABLE IF NOT EXISTS honeymoon_documents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  wedding_id UUID NOT NULL REFERENCES weddings(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  note TEXT,
  status TEXT NOT NULL DEFAULT 'to_do',
  original_name TEXT,
  storage_key TEXT UNIQUE,
  content_type TEXT,
  byte_size INTEGER CHECK (byte_size >= 0),
  checksum_sha256 TEXT,
  archived_at TIMESTAMPTZ,
  created_by UUID NOT NULL REFERENCES users(id),
  updated_by UUID NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS honeymoon_documents_active_idx ON honeymoon_documents (wedding_id, status, created_at) WHERE archived_at IS NULL;
