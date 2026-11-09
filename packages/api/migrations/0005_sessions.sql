-- M2 sessions: members are FIDs that have opened a session
-- here. Ingestion queues each member's own-history steps in `deliveries`, in the same batch
-- as the page and its cursor; the ingestion object hands them to the member's user object in
-- event order and deletes them once applied (exactly-once delivery).

CREATE TABLE IF NOT EXISTS members (
  fid       INTEGER PRIMARY KEY,
  joined_ts INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS deliveries (
  fid      INTEGER NOT NULL,
  shard    INTEGER NOT NULL,
  event_id INTEGER NOT NULL,
  seq      INTEGER NOT NULL,             -- position within the event: the merge, then what it displaced
  payload  TEXT NOT NULL,                -- JSON: { op, msg }
  PRIMARY KEY (fid, shard, event_id, seq)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS deliveries_shard ON deliveries(shard, fid);
