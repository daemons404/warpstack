-- rev: the index's clock. Every ingestion batch sets
-- rev = max(rev + 1, now in ms) in its own transaction, so it rises with every page and
-- keeps rising across a wipe and refill. Reads take it before their data.
CREATE TABLE index_meta (
  k   INTEGER PRIMARY KEY CHECK (k = 1),
  rev INTEGER NOT NULL
);
INSERT INTO index_meta (k, rev) VALUES (1, 0);

-- Casts become tombstones instead of disappearing: 0 live, 1 deleted (a remove, prune or
-- revoke), 2 taken down. Lists read live casts only; cast.get and threads say which.
ALTER TABLE casts ADD COLUMN state INTEGER NOT NULL DEFAULT 0;

-- Prune count rows by their own time index.
CREATE INDEX IF NOT EXISTS recasts_ts ON recasts(ts);
