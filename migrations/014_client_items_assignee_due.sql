-- Migratie 014: To do-items kunnen aan iemand toegewezen worden (taggen) en een
-- deadline krijgen, zodat taken op volgorde van wanneer ze moeten gebeuren staan.
-- Draai eenmalig in Neon.
ALTER TABLE marketing.client_items
  ADD COLUMN IF NOT EXISTS assignee_account_id INTEGER,
  ADD COLUMN IF NOT EXISTS due_date DATE;

CREATE INDEX IF NOT EXISTS client_items_assignee_idx
  ON marketing.client_items (assignee_account_id, done, due_date);
