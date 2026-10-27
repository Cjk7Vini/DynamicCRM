-- Migratie 024: Instagram-login (Instagram API with Instagram Login). Voor klanten
-- met wel Instagram maar geen Facebook-pagina. Het token hoort bij graph.instagram.com
-- en is apart van het Facebook-token. Draai eenmalig in Neon.
ALTER TABLE marketing.client_integrations
  ADD COLUMN IF NOT EXISTS ig_login_token      TEXT,
  ADD COLUMN IF NOT EXISTS ig_login_user_id    TEXT,
  ADD COLUMN IF NOT EXISTS ig_login_username    TEXT,
  ADD COLUMN IF NOT EXISTS ig_login_expires_at TIMESTAMPTZ;
