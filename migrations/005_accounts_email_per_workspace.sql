-- Multi-workspace login: sta hetzelfde e-mailadres toe in meerdere workspaces
-- (een klant-login die zowel bij bureau A als bureau B binnenkomt), met een
-- gedeeld wachtwoord. Hiervoor moet de e-mail niet langer GLOBAAL uniek zijn,
-- maar uniek PER (email, workspace_id).
--
-- Deze migratie is defensief: hij zoekt zelf de bestaande unieke constraint/
-- index op die EXACT en ALLEEN op (email) staat, verwijdert die, en maakt de
-- nieuwe samengestelde unieke index. De primary key en samengestelde indexen
-- worden nooit geraakt. Draai dit eenmalig in Neon.

DO $$
DECLARE r record;
BEGIN
  -- Unieke CONSTRAINTS die exact en alleen op (email) staan.
  FOR r IN
    SELECT c.conname
    FROM pg_constraint c
    WHERE c.conrelid = 'marketing.accounts'::regclass
      AND c.contype = 'u'
      AND (SELECT array_agg(a.attname::text ORDER BY a.attname)
             FROM unnest(c.conkey) k
             JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k
          ) = ARRAY['email']::text[]
  LOOP
    EXECUTE format('ALTER TABLE marketing.accounts DROP CONSTRAINT %I', r.conname);
  END LOOP;

  -- Unieke INDEXEN die exact en alleen op (email) staan en geen constraint-index zijn.
  FOR r IN
    SELECT i.indexrelid::regclass::text AS idxname
    FROM pg_index i
    WHERE i.indrelid = 'marketing.accounts'::regclass
      AND i.indisunique
      AND NOT i.indisprimary
      AND (SELECT array_agg(a.attname::text ORDER BY a.attname)
             FROM unnest(i.indkey) k
             JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = k
          ) = ARRAY['email']::text[]
      AND NOT EXISTS (SELECT 1 FROM pg_constraint c WHERE c.conindid = i.indexrelid)
  LOOP
    EXECUTE format('DROP INDEX %s', r.idxname);
  END LOOP;
END $$;

-- Nieuwe uniekheid: hetzelfde e-mailadres mag maar één keer per workspace.
CREATE UNIQUE INDEX IF NOT EXISTS accounts_email_workspace_uniq
  ON marketing.accounts(email, workspace_id);
