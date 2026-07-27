ALTER TABLE weddings ADD COLUMN IF NOT EXISTS rsvp_deadline DATE;
CREATE INDEX IF NOT EXISTS weddings_rsvp_deadline_idx ON weddings (rsvp_deadline) WHERE rsvp_deadline IS NOT NULL;
