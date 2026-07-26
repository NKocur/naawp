CREATE TABLE IF NOT EXISTS guests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  wedding_id UUID NOT NULL REFERENCES weddings(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  guest_group TEXT,
  party_size INTEGER NOT NULL DEFAULT 1 CHECK (party_size > 0),
  rsvp TEXT NOT NULL DEFAULT 'pending' CHECK (rsvp IN ('pending','attending','declined')),
  notes TEXT,
  archived_at TIMESTAMPTZ,
  created_by UUID NOT NULL REFERENCES users(id),
  updated_by UUID NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS guests_active_idx ON guests (wedding_id, rsvp, name) WHERE archived_at IS NULL;
