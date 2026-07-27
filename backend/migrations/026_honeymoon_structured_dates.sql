ALTER TABLE honeymoon_profiles ADD COLUMN IF NOT EXISTS starts_on DATE;
ALTER TABLE honeymoon_profiles ADD COLUMN IF NOT EXISTS ends_on DATE;
ALTER TABLE honeymoon_profiles ADD CONSTRAINT honeymoon_profiles_date_range_check CHECK (ends_on IS NULL OR starts_on IS NULL OR ends_on >= starts_on);

ALTER TABLE travel_reservations ADD COLUMN IF NOT EXISTS starts_on DATE;
ALTER TABLE travel_reservations ADD COLUMN IF NOT EXISTS ends_on DATE;
ALTER TABLE travel_reservations ADD COLUMN IF NOT EXISTS starts_at TIME;
ALTER TABLE travel_reservations ADD COLUMN IF NOT EXISTS ends_at TIME;
ALTER TABLE travel_reservations ADD CONSTRAINT travel_reservations_date_range_check CHECK (ends_on IS NULL OR starts_on IS NULL OR ends_on >= starts_on);

CREATE INDEX IF NOT EXISTS travel_reservations_active_trip_range_idx
  ON travel_reservations (wedding_id, starts_on, ends_on)
  WHERE archived_at IS NULL;
