-- Migratie 023: uitgebreider klantprofiel. Bij het aanmaken van een klant kan nu
-- een logo, branche, doelstelling(en), doelgroep en social-media-kanalen worden
-- vastgelegd. Deze gegevens geven de AI meer context en verrijken de klant-space.
-- Draai eenmalig in Neon.
ALTER TABLE marketing.clients
  ADD COLUMN IF NOT EXISTS logo_url TEXT,
  ADD COLUMN IF NOT EXISTS branche  TEXT,
  ADD COLUMN IF NOT EXISTS goals    TEXT[],
  ADD COLUMN IF NOT EXISTS audience TEXT,
  ADD COLUMN IF NOT EXISTS channels TEXT[];
