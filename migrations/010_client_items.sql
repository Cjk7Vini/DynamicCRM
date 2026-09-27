-- Migratie 010: To do-items en Documenten per klant (Content planning).
-- Draai eenmalig in Neon.
CREATE TABLE IF NOT EXISTS marketing.client_items (
  id SERIAL PRIMARY KEY,
  workspace_id INTEGER NOT NULL,
  client_id INTEGER NOT NULL,
  kind TEXT NOT NULL,           -- 'todo' of 'document'
  title TEXT NOT NULL,
  url TEXT,
  done BOOLEAN DEFAULT FALSE,
  created_by INTEGER,
  created_at TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS client_items_client_kind_idx
  ON marketing.client_items (client_id, kind, created_at);
