CREATE TABLE IF NOT EXISTS honeymoon_itinerary_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  wedding_id UUID NOT NULL REFERENCES weddings(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  planned_on DATE NOT NULL,
  note TEXT,
  archived_at TIMESTAMPTZ,
  created_by UUID NOT NULL REFERENCES users(id),
  updated_by UUID NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS honeymoon_itinerary_active_idx ON honeymoon_itinerary_items (wedding_id, planned_on) WHERE archived_at IS NULL;
