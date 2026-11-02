-- Migratie 029: welke admins create-user mogen gebruiken. De superadmin
-- (admin@dynamic-health-consultancy.nl) heeft altijd toegang; andere admins alleen als
-- de superadmin dat aanvinkt. Standaard: geen toegang. Draai eenmalig in Neon.
ALTER TABLE public.users
  ADD COLUMN IF NOT EXISTS create_user_access BOOLEAN NOT NULL DEFAULT FALSE;
