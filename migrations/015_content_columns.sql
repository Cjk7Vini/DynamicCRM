-- Migratie 015: eigen kolommen voor de Planning (contentplanning-bord) per werkplek.
-- De vier standaardkolommen worden de eerste keer dat de Planning geladen wordt
-- automatisch aangemaakt; daarna kun je ze hernoemen, verslepen, verwijderen en
-- extra kolommen toevoegen. Draai eenmalig in Neon.
CREATE TABLE IF NOT EXISTS marketing.content_columns (
  id SERIAL PRIMARY KEY,
  workspace_id INTEGER NOT NULL,
  col_key TEXT NOT NULL,          -- status-sleutel die op de post komt
  label TEXT NOT NULL,
  position INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE (workspace_id, col_key)
);
CREATE INDEX IF NOT EXISTS content_columns_ws_idx
  ON marketing.content_columns (workspace_id, position);
