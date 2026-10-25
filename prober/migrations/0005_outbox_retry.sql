ALTER TABLE outbox ADD COLUMN next_at INTEGER NOT NULL DEFAULT 0;
UPDATE outbox SET next_at = at WHERE dead = 1;
DELETE FROM outbox WHERE kind IN ('deployed', 'resumed', 'self-ok', 'self-failing');
