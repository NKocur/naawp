CREATE TABLE IF NOT EXISTS idea_board_attachments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  board_id UUID NOT NULL REFERENCES idea_boards(id) ON DELETE CASCADE,
  wedding_id UUID NOT NULL REFERENCES weddings(id) ON DELETE CASCADE,
  caption TEXT NOT NULL,
  source_url TEXT,
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

CREATE INDEX IF NOT EXISTS idea_board_attachments_active_idx ON idea_board_attachments (board_id, created_at) WHERE archived_at IS NULL;
