-- Migratie 018: carousel-posts. Een post kan meerdere bestanden bevatten die als
-- een Instagram-carousel (organische post) gepubliceerd worden. Draai in Neon.
ALTER TABLE marketing.content_posts
  ADD COLUMN IF NOT EXISTS carousel_asset_ids INTEGER[];
