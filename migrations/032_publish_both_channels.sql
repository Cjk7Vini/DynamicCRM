-- 032: Publiceren naar Instagram EN Facebook tegelijk.
-- Per kanaal wordt vastgelegd wanneer de post daar geplaatst is. Zo plaatst een
-- nieuwe poging alleen het kanaal dat nog niet gelukt is, en nooit dubbel.
-- publish_channel kan daarna ook 'both' zijn (de kolom is text, zonder CHECK).
-- Bestaande data wordt niet aangeraakt: de nieuwe kolommen beginnen leeg.

ALTER TABLE marketing.content_posts ADD COLUMN IF NOT EXISTS ig_published_at TIMESTAMPTZ;
ALTER TABLE marketing.content_posts ADD COLUMN IF NOT EXISTS fb_published_at TIMESTAMPTZ;

-- Terugdraaien (alleen als het echt nodig is):
-- UPDATE marketing.content_posts SET publish_channel='instagram' WHERE publish_channel='both';
-- ALTER TABLE marketing.content_posts DROP COLUMN IF EXISTS ig_published_at;
-- ALTER TABLE marketing.content_posts DROP COLUMN IF EXISTS fb_published_at;
