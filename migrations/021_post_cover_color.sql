-- Migratie 021: omslagkleur per kaart (Planning), zoals de kaart-cover in Trello.
-- Een kaart krijgt een gekleurde balk bovenaan. Draai eenmalig in Neon.
ALTER TABLE marketing.content_posts
  ADD COLUMN IF NOT EXISTS cover_color TEXT;
