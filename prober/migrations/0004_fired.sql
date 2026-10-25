ALTER TABLE relay_keys ADD COLUMN description TEXT;
CREATE TABLE relay_fired (
  relay TEXT NOT NULL, "key" TEXT NOT NULL, title TEXT NOT NULL,
  n INTEGER NOT NULL, first_at INTEGER NOT NULL, last_at INTEGER NOT NULL,
  PRIMARY KEY (relay, "key")
);
