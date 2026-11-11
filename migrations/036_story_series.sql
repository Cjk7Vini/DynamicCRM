-- 036: story-reeks (meerdere stories na elkaar vanuit één post).
-- De bestanden van de reeks staan in de bestaande kolom carousel_asset_ids (in volgorde).
-- story_done houdt bij hoeveel stories van de reeks al op Instagram staan, zodat een
-- nieuwe poging na een fout of herstart alleen de rest plaatst en nooit dubbel.
-- Bestaande data wordt niet aangeraakt.

ALTER TABLE marketing.content_posts ADD COLUMN IF NOT EXISTS story_done INTEGER NOT NULL DEFAULT 0;

-- Terugdraaien (alleen als het echt nodig is):
-- UPDATE marketing.content_posts SET post_type='story' WHERE post_type='storyreeks';
-- ALTER TABLE marketing.content_posts DROP COLUMN IF EXISTS story_done;
