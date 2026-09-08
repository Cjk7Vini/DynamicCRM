-- Opslagbeheer voor Marketing Studio werkplekken.
-- Voer dit eenmalig uit in Neon. De code werkt ook zonder deze kolommen
-- (dan geldt de standaard van 10 GB en 60 dagen), maar met de kolommen kun
-- je per werkplek een eigen opslaglimiet en bewaartermijn instellen.

ALTER TABLE marketing.workspaces
  ADD COLUMN IF NOT EXISTS storage_quota_mb integer NOT NULL DEFAULT 10240;

ALTER TABLE marketing.workspaces
  ADD COLUMN IF NOT EXISTS retention_days integer NOT NULL DEFAULT 60;
