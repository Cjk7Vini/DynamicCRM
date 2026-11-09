-- 033: eigen omslag (cover) bij een Reel. Verwijst naar een afbeelding uit Content
-- van dezelfde klant. Instagram krijgt die mee als cover_url bij het plaatsen.
-- Bestaande data wordt niet aangeraakt: de kolom begint leeg (= automatische omslag).

ALTER TABLE marketing.content_posts ADD COLUMN IF NOT EXISTS reel_cover_asset_id INTEGER;

-- Terugdraaien (alleen als het echt nodig is):
-- ALTER TABLE marketing.content_posts DROP COLUMN IF EXISTS reel_cover_asset_id;
