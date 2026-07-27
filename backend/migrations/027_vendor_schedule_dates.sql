ALTER TABLE vendors ADD COLUMN IF NOT EXISTS contract_due_on DATE;
ALTER TABLE vendors ADD COLUMN IF NOT EXISTS deposit_due_on DATE;
ALTER TABLE vendors ADD COLUMN IF NOT EXISTS final_payment_due_on DATE;
ALTER TABLE vendors ADD COLUMN IF NOT EXISTS service_on DATE;

CREATE INDEX IF NOT EXISTS vendors_wedding_schedule_dates_idx
  ON vendors (wedding_id, contract_due_on, deposit_due_on, final_payment_due_on, service_on)
  WHERE archived_at IS NULL;
