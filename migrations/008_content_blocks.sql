-- Migratie 008: sleepbare tekstblokken rond het beeld op een contentkaart.
-- Draai dit eenmalig in Neon. Zonder deze kolom valt de kaart terug op 1 tekstveld.
ALTER TABLE marketing.content_posts
  ADD COLUMN IF NOT EXISTS content_blocks JSONB;
