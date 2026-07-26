ALTER TABLE tasks
  ADD COLUMN IF NOT EXISTS assignee_user_id UUID REFERENCES users(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS tasks_assignee_user_idx
  ON tasks (wedding_id, assignee_user_id) WHERE archived_at IS NULL;
