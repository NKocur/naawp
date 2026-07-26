CREATE TABLE IF NOT EXISTS honeymoon_profiles (
  wedding_id UUID PRIMARY KEY REFERENCES weddings(id) ON DELETE CASCADE,
  destination TEXT,
  dates_label TEXT,
  description TEXT,
  planned_budget NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (planned_budget >= 0),
  other_committed NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (other_committed >= 0),
  updated_by UUID REFERENCES users(id) ON DELETE SET NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS travel_reservations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  wedding_id UUID NOT NULL REFERENCES weddings(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  type TEXT NOT NULL DEFAULT 'other',
  status TEXT NOT NULL DEFAULT 'pending',
  confirmation TEXT,
  details TEXT,
  total NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (total >= 0),
  paid NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (paid >= 0),
  due_date DATE,
  archived_at TIMESTAMPTZ,
  created_by UUID NOT NULL REFERENCES users(id),
  updated_by UUID NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS travel_reservations_active_idx ON travel_reservations (wedding_id, due_date) WHERE archived_at IS NULL;
