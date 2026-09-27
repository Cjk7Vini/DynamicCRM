-- Migratie 007: labels op contentkaarten + opmerkingen-thread per kaart.
-- De app-databasegebruiker mag zelf geen DDL draaien in schema marketing,
-- daarom draai je dit eenmalig in Neon.

-- Labels (gekleurde tags) op een contentpost. Opgeslagen als tekst-array met
-- vaste sleutels (bv. 'tekst_geschreven', 'klaar_controle', 'goedgekeurd').
ALTER TABLE marketing.content_posts
  ADD COLUMN IF NOT EXISTS labels TEXT[] DEFAULT '{}';

-- Opmerkingen/communicatie tussen agency en klant op een contentkaart.
CREATE TABLE IF NOT EXISTS marketing.content_comments (
  id SERIAL PRIMARY KEY,
  workspace_id INTEGER NOT NULL,
  client_id INTEGER NOT NULL,
  post_id INTEGER NOT NULL,
  author_account_id INTEGER,
  author_role TEXT,
  author_name TEXT,
  body TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS content_comments_post_idx
  ON marketing.content_comments (post_id, created_at);
