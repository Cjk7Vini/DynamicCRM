-- Migratie 020: kleur per Planning-kolom, zodat een agency een kolom volledig naar
-- wens kan aanpassen (naam en kleur). Draai eenmalig in Neon.
ALTER TABLE marketing.content_columns
  ADD COLUMN IF NOT EXISTS color TEXT;
