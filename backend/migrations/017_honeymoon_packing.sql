CREATE TABLE IF NOT EXISTS honeymoon_packing_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  wedding_id UUID NOT NULL REFERENCES weddings(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  packed BOOLEAN NOT NULL DEFAULT false,
  archived_at TIMESTAMPTZ,
  created_by UUID NOT NULL REFERENCES users(id),
  updated_by UUID NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS honeymoon_packing_active_idx ON honeymoon_packing_items (wedding_id, packed, created_at) WHERE archived_at IS NULL;
