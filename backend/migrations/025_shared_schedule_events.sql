CREATE TABLE IF NOT EXISTS schedule_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  wedding_id UUID NOT NULL REFERENCES weddings(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  event_type TEXT NOT NULL DEFAULT 'other' CHECK (event_type IN ('meeting','appointment','reminder','travel','ceremony','other')),
  starts_on DATE NOT NULL,
  ends_on DATE,
  starts_at TIME,
  ends_at TIME,
  location TEXT,
  notes TEXT,
  archived_at TIMESTAMPTZ,
  created_by UUID NOT NULL REFERENCES users(id),
  updated_by UUID NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (ends_on IS NULL OR ends_on >= starts_on)
);

CREATE INDEX IF NOT EXISTS schedule_events_wedding_range_idx
  ON schedule_events (wedding_id, starts_on, ends_on)
  WHERE archived_at IS NULL;
