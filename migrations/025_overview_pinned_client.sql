-- Migratie 025: vastgepinde klant voor de hoofd-overzichtspagina. Een werkplek-
-- eigenaar kan een specifieke klant kiezen die altijd op het hoofd-overzicht
-- wordt getoond (bijv. een bureau dat zijn eigen bedrijf als klant beheert en
-- daar alleen die cijfers wil zien). Leeg = algemeen overzicht over alle klanten.
-- Draai eenmalig in Neon.
ALTER TABLE marketing.workspaces
  ADD COLUMN IF NOT EXISTS overview_client_id INTEGER;
