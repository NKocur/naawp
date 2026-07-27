ALTER TABLE weddings
  ADD COLUMN IF NOT EXISTS budget_total NUMERIC(12,2) NOT NULL DEFAULT 0
  CHECK (budget_total >= 0);
