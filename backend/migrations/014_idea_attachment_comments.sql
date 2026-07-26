CREATE TABLE IF NOT EXISTS idea_attachment_comments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  attachment_id UUID NOT NULL REFERENCES idea_board_attachments(id) ON DELETE CASCADE,
  wedding_id UUID NOT NULL REFERENCES weddings(id) ON DELETE CASCADE,
  body TEXT NOT NULL,
  created_by UUID NOT NULL REFERENCES users(id),
  updated_by UUID NOT NULL REFERENCES users(id),
  archived_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idea_attachment_comments_active_idx ON idea_attachment_comments (attachment_id, created_at) WHERE archived_at IS NULL;
