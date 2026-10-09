CREATE TABLE state (
  "check" TEXT PRIMARY KEY,
  avail INTEGER NOT NULL,
  degraded INTEGER NOT NULL,
  fails INTEGER NOT NULL,
  passes INTEGER NOT NULL,
  since INTEGER NOT NULL,
  slot INTEGER NOT NULL,
  last_ok INTEGER,
  last_run INTEGER,
  reason TEXT
);

CREATE TABLE samples (
  "check" TEXT NOT NULL,
  at INTEGER NOT NULL,
  ms INTEGER NOT NULL,
  ok INTEGER NOT NULL,
  PRIMARY KEY ("check", at)
);

CREATE TABLE daily (
  "check" TEXT NOT NULL,
  day TEXT NOT NULL,
  runs INTEGER NOT NULL,
  down INTEGER NOT NULL,
  maint INTEGER NOT NULL,
  PRIMARY KEY ("check", day)
);

CREATE TABLE beats (
  "check" TEXT PRIMARY KEY,
  at INTEGER NOT NULL,
  ok INTEGER NOT NULL
);

CREATE TABLE events (
  "check" TEXT NOT NULL,
  at INTEGER NOT NULL,
  "from" TEXT NOT NULL,
  "to" TEXT NOT NULL
);

CREATE TABLE outbox (
  "check" TEXT NOT NULL,
  at INTEGER NOT NULL,
  kind TEXT NOT NULL,
  since INTEGER NOT NULL,
  reason TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  dead INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY ("check", at)
);

CREATE TABLE meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
