ALTER TABLE outbox ADD COLUMN "key" TEXT NOT NULL DEFAULT '';

CREATE TABLE relay_keys (
  relay TEXT NOT NULL,
  "key" TEXT NOT NULL,
  title TEXT NOT NULL,
  since INTEGER NOT NULL,
  seen INTEGER NOT NULL,
  PRIMARY KEY (relay, "key")
);
