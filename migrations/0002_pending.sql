CREATE TABLE pending (
  service TEXT NOT NULL,
  at INTEGER NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('up', 'down')),
  since INTEGER NOT NULL,
  reason TEXT,
  PRIMARY KEY (service, at)
);
