-- Migratie 016: kaarten (posts) krijgen toegewezen personen, een checklist en een
-- activiteiten-log, zoals in Trello. Draai eenmalig in Neon.
ALTER TABLE marketing.content_posts
  ADD COLUMN IF NOT EXISTS assignees INTEGER[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS checklist JSONB NOT NULL DEFAULT '[]'::jsonb;

CREATE TABLE IF NOT EXISTS marketing.content_post_activity (
  id SERIAL PRIMARY KEY,
  workspace_id INTEGER NOT NULL,
  post_id INTEGER NOT NULL,
  actor_account_id INTEGER,
  actor_name TEXT,
  action TEXT NOT NULL,
  detail TEXT,
  created_at TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS content_post_activity_post_idx
  ON marketing.content_post_activity (post_id, created_at);
