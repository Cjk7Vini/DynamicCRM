-- Migratie 019: week van een kaart in de Planning, LOS van de status. De statussen
-- zijn de kolommen (werkstroom), de weken zijn de rijen (swimlanes). Draai in Neon.
ALTER TABLE marketing.content_posts
  ADD COLUMN IF NOT EXISTS board_week INTEGER;
