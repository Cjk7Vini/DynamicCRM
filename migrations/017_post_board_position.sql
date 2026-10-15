-- Migratie 017: handmatige volgorde van kaarten binnen een kolom in de Planning
-- (verticaal slepen om de plek te wijzigen). Draai eenmalig in Neon.
ALTER TABLE marketing.content_posts
  ADD COLUMN IF NOT EXISTS board_position INTEGER;
