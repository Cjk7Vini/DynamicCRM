-- Migratie 013: vervaldatum van het Meta access token opslaan, voor de
-- verleng-herinnering in de workspace. Draai eenmalig in Neon.
ALTER TABLE marketing.client_integrations
  ADD COLUMN IF NOT EXISTS meta_token_expires_at TIMESTAMPTZ;
ALTER TABLE marketing.workspace_integrations
  ADD COLUMN IF NOT EXISTS meta_token_expires_at TIMESTAMPTZ;
