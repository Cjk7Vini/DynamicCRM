-- Migratie 031: categorieën met een eigen kleur voor de agenda (bijv. Meeting, Content, Admin).
-- Per werkplek in te stellen bij Instellingen. Een taak kan optioneel een categorie hebben.
-- In de agenda kies je "Kleur op klant" of "Kleur op categorie".
-- Draai eenmalig in Neon (na migratie 030).
CREATE TABLE IF NOT EXISTS marketing.agenda_categories (
  id           SERIAL PRIMARY KEY,
  workspace_id INTEGER NOT NULL,
  name         TEXT NOT NULL,
  color        TEXT NOT NULL,
  position     INTEGER NOT NULL DEFAULT 0,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS agenda_categories_ws_idx ON marketing.agenda_categories (workspace_id, position);

ALTER TABLE marketing.client_items
  ADD COLUMN IF NOT EXISTS category_id INTEGER;
