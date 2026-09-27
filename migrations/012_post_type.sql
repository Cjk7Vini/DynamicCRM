-- Migratie 012: expliciet posttype (Bericht/Reel/Story/Carrousel) op een contentpost.
-- Draai eenmalig in Neon. Zonder deze kolom leidt de app het type af van het bestand.
ALTER TABLE marketing.content_posts
  ADD COLUMN IF NOT EXISTS post_type TEXT;
