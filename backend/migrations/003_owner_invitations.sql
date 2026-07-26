ALTER TABLE invitations DROP CONSTRAINT IF EXISTS invitations_role_check;
ALTER TABLE invitations
  ADD CONSTRAINT invitations_role_check
  CHECK (role IN ('owner', 'editor', 'contributor', 'viewer'));
