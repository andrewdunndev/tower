CREATE TABLE state (
  service TEXT PRIMARY KEY,
  down INTEGER NOT NULL,
  fails INTEGER NOT NULL,
  passes INTEGER NOT NULL,
  since INTEGER NOT NULL,
  checked INTEGER NOT NULL
);

CREATE TABLE daily (
  service TEXT NOT NULL,
  day TEXT NOT NULL,
  checks INTEGER NOT NULL,
  down INTEGER NOT NULL,
  PRIMARY KEY (service, day)
);

CREATE TABLE events (
  service TEXT NOT NULL,
  at INTEGER NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('up', 'down'))
);

CREATE INDEX events_at ON events (at);
