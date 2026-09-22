-- Migratie 006: opmerkingen op campagnes + geplande (concept) campagnes.
-- De app-databasegebruiker mag zelf geen tabellen aanmaken in schema marketing,
-- daarom worden deze tabellen hier eenmalig aangemaakt (draai dit in Neon).

-- Opmerkingen/feedback van klant en team op een (live of geplande) campagne.
CREATE TABLE IF NOT EXISTS marketing.campaign_feedback (
  id SERIAL PRIMARY KEY,
  workspace_id INTEGER NOT NULL,
  client_id INTEGER NOT NULL,
  meta_campaign_id TEXT NOT NULL,
  author_account_id INTEGER,
  author_role TEXT,
  author_name TEXT,
  body TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS campaign_feedback_ws_client_camp_idx
  ON marketing.campaign_feedback (workspace_id, client_id, meta_campaign_id);

-- Geplande (concept) campagnes die het team klaarzet en de klant goedkeurt.
CREATE TABLE IF NOT EXISTS marketing.campaign_drafts (
  id SERIAL PRIMARY KEY,
  workspace_id INTEGER NOT NULL,
  client_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  objective TEXT,
  daily_budget_cents INTEGER,
  audience TEXT,
  ad_text TEXT,
  planned_start DATE,
  notes TEXT,
  status TEXT DEFAULT 'concept',
  created_by INTEGER,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS campaign_drafts_ws_client_idx
  ON marketing.campaign_drafts (workspace_id, client_id);
