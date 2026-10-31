-- Migratie 028: per platform-admin bepalen welke marketing-workspaces zichtbaar zijn.
-- NULL = alle workspaces (zoals voorheen). Een lijst = alleen die workspaces.
-- Draai eenmalig in Neon.
ALTER TABLE public.users
  ADD COLUMN IF NOT EXISTS mkt_workspace_ids INTEGER[];
