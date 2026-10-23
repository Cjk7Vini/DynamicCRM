-- Migratie 022: white-label huisstijl per werkplek. Een bureau kan een eigen
-- merknaam, logo en accentkleuren instellen, die in de hele workspace worden
-- toegepast. Draai eenmalig in Neon.
ALTER TABLE marketing.workspaces
  ADD COLUMN IF NOT EXISTS brand_name     TEXT,
  ADD COLUMN IF NOT EXISTS logo_url       TEXT,
  ADD COLUMN IF NOT EXISTS accent_color   TEXT,
  ADD COLUMN IF NOT EXISTS accent_color_2 TEXT;
