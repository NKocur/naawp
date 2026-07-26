CREATE TABLE IF NOT EXISTS budget_categories (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  wedding_id UUID NOT NULL REFERENCES weddings(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  planned_amount NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (planned_amount >= 0),
  created_by UUID NOT NULL REFERENCES users(id),
  updated_by UUID NOT NULL REFERENCES users(id),
  archived_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (wedding_id, name)
);

CREATE TABLE IF NOT EXISTS vendors (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  wedding_id UUID NOT NULL REFERENCES weddings(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  category TEXT NOT NULL DEFAULT 'Other',
  status TEXT NOT NULL DEFAULT 'researching' CHECK (status IN ('researching','contacted','quoted','shortlisted','booked','declined','cancelled')),
  contact TEXT,
  notes TEXT,
  terms TEXT,
  archived_at TIMESTAMPTZ,
  created_by UUID NOT NULL REFERENCES users(id),
  updated_by UUID NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE expenses ADD COLUMN IF NOT EXISTS budget_category_id UUID REFERENCES budget_categories(id) ON DELETE SET NULL;
ALTER TABLE expenses ADD COLUMN IF NOT EXISTS vendor_id UUID REFERENCES vendors(id) ON DELETE SET NULL;
ALTER TABLE expenses ADD COLUMN IF NOT EXISTS currency CHAR(3) NOT NULL DEFAULT 'USD';
ALTER TABLE expenses ADD COLUMN IF NOT EXISTS stage TEXT NOT NULL DEFAULT 'estimated' CHECK (stage IN ('estimated','quoted','committed','partially_paid','paid','refunded','cancelled'));
ALTER TABLE expenses ADD COLUMN IF NOT EXISTS due_date DATE;
ALTER TABLE expenses ADD COLUMN IF NOT EXISTS description TEXT;

CREATE TABLE IF NOT EXISTS payments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  wedding_id UUID NOT NULL REFERENCES weddings(id) ON DELETE CASCADE,
  expense_id UUID REFERENCES expenses(id) ON DELETE SET NULL,
  vendor_id UUID REFERENCES vendors(id) ON DELETE SET NULL,
  payer_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  payer_label TEXT,
  amount NUMERIC(12,2) NOT NULL CHECK (amount > 0),
  currency CHAR(3) NOT NULL DEFAULT 'USD',
  paid_on DATE NOT NULL DEFAULT CURRENT_DATE,
  method TEXT,
  reimbursement_status TEXT NOT NULL DEFAULT 'none' CHECK (reimbursement_status IN ('none','owed','settled')),
  notes TEXT,
  archived_at TIMESTAMPTZ,
  created_by UUID NOT NULL REFERENCES users(id),
  updated_by UUID NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS payment_splits (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  payment_id UUID NOT NULL REFERENCES payments(id) ON DELETE CASCADE,
  owed_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  owed_by_label TEXT,
  amount NUMERIC(12,2) NOT NULL CHECK (amount > 0),
  settled_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS vendors_wedding_active_idx ON vendors (wedding_id, status) WHERE archived_at IS NULL;
CREATE INDEX IF NOT EXISTS payments_wedding_active_idx ON payments (wedding_id, paid_on DESC) WHERE archived_at IS NULL;
CREATE INDEX IF NOT EXISTS expenses_wedding_stage_idx ON expenses (wedding_id, stage) WHERE archived_at IS NULL;
