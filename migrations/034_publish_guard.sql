-- 034: beveiliging tegen dubbel plaatsen door de planner.
-- De planner legt per post vast dat hij ermee bezig is en, vlak voor het echte
-- plaatsen, op welk kanaal en met welke Instagram-container. Na een herstart of bij
-- twee servers tegelijk kan hij zo zien of een post al geplaatst is, in plaats van
-- hem opnieuw te plaatsen. De kolom is leeg zolang er niets loopt.
-- Bestaande data wordt niet aangeraakt.

ALTER TABLE marketing.content_posts ADD COLUMN IF NOT EXISTS publish_state JSONB;

-- Terugdraaien (alleen als het echt nodig is):
-- ALTER TABLE marketing.content_posts DROP COLUMN IF EXISTS publish_state;
