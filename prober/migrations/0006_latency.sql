CREATE INDEX samples_at ON samples (at);

CREATE TABLE histogram (
  "check" TEXT NOT NULL,
  ms INTEGER NOT NULL,
  n INTEGER NOT NULL,
  PRIMARY KEY ("check", ms)
) WITHOUT ROWID;

CREATE TABLE buckets (
  bucket INTEGER NOT NULL,
  "check" TEXT NOT NULL,
  n INTEGER NOT NULL,
  total INTEGER NOT NULL,
  PRIMARY KEY (bucket, "check")
) WITHOUT ROWID;
