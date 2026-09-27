-- Migratie 011: eigen (custom) labels per werkplek voor Content planning.
-- Draai eenmalig in Neon. Sleutel van een custom label op een post = 'c' + id.
CREATE TABLE IF NOT EXISTS marketing.content_labels (
  id SERIAL PRIMARY KEY,
  workspace_id INTEGER NOT NULL,
  label TEXT NOT NULL,
  color TEXT DEFAULT '#6366f1',
  created_at TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS content_labels_ws_idx ON marketing.content_labels (workspace_id);
