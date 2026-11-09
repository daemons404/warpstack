-- The cast index. Four weeks of casts, recasts, counts and the
-- profiles they need, rebuilt from the event stream. Hashes are lowercase 0x-hex TEXT.

CREATE TABLE casts (
  hash        TEXT PRIMARY KEY,
  fid         INTEGER NOT NULL,
  ts          INTEGER NOT NULL,          -- Unix seconds
  reply       INTEGER NOT NULL,          -- 1 if it has a parent cast
  parent_hash TEXT,
  parent_fid  INTEGER,                   -- every cast reference carries its FID
  channel     TEXT,                      -- parent URL of a top-level channel cast
  type        TEXT NOT NULL,             -- cast, long or tenK
  text        TEXT NOT NULL,
  embeds      TEXT NOT NULL,             -- JSON, at most 4
  mentions    TEXT NOT NULL              -- JSON, at most 10
) WITHOUT ROWID;

-- Each index names the full pagination order, so a page is a range read with no sort.
CREATE INDEX casts_author  ON casts(fid, ts DESC, hash DESC, reply);
CREATE INDEX casts_channel ON casts(channel, ts DESC, hash DESC) WHERE channel IS NOT NULL;
CREATE INDEX casts_parent  ON casts(parent_hash, ts DESC, hash DESC) WHERE parent_hash IS NOT NULL;
CREATE INDEX casts_time    ON casts(ts DESC, hash DESC, fid);

CREATE TABLE recasts (
  hash        TEXT PRIMARY KEY,          -- the recast's own message hash
  fid         INTEGER NOT NULL,
  ts          INTEGER NOT NULL,
  target_hash TEXT NOT NULL,
  target_fid  INTEGER NOT NULL
) WITHOUT ROWID;
CREATE INDEX recasts_author ON recasts(fid, ts DESC, hash DESC);
CREATE INDEX recasts_time   ON recasts(ts DESC, hash DESC);

-- Separate, so a reaction can land before its cast does.
CREATE TABLE cast_counts (
  hash     TEXT PRIMARY KEY,
  likes    INTEGER NOT NULL DEFAULT 0,
  recasts  INTEGER NOT NULL DEFAULT 0,
  replies  INTEGER NOT NULL DEFAULT 0,
  first_ts INTEGER NOT NULL              -- for pruning rows whose cast never arrives
) WITHOUT ROWID;
CREATE INDEX cast_counts_time ON cast_counts(first_ts);

CREATE TABLE users (
  fid             INTEGER PRIMARY KEY,
  username        TEXT,
  display         TEXT,
  pfp             TEXT,
  bio             TEXT,
  url             TEXT,
  location        TEXT,
  banner          TEXT,
  primary_addr    TEXT,
  verified        TEXT,                  -- JSON array of addresses, from the last fill
  pro             INTEGER NOT NULL DEFAULT 0,
  followers       INTEGER,               -- bounded lazy counts, refreshed daily
  following       INTEGER,
  counts_bounded  INTEGER NOT NULL DEFAULT 0,
  counts_ts       INTEGER,
  complete        INTEGER NOT NULL DEFAULT 0,  -- 1 once filled from userData, not only from events
  updated_ts      INTEGER NOT NULL
);
CREATE INDEX users_name ON users(username) WHERE username IS NOT NULL;

CREATE TABLE channels (
  key            TEXT PRIMARY KEY,
  url            TEXT NOT NULL,
  name           TEXT NOT NULL,
  description    TEXT,
  image          TEXT,
  moderators     TEXT NOT NULL,          -- JSON array of FIDs
  follower_count INTEGER,
  updated_ts     INTEGER NOT NULL
) WITHOUT ROWID;
CREATE INDEX channels_url  ON channels(url);
CREATE INDEX channels_name ON channels(lower(name));

CREATE TABLE ingest_cursor (
  shard          INTEGER PRIMARY KEY,
  last_event_id  INTEGER NOT NULL,
  prev_event_id  INTEGER NOT NULL,
  last_block_ts  INTEGER NOT NULL,
  covered_since  INTEGER NOT NULL        -- the index is complete for this shard from here on
);

-- The cursor guard. D1 triggers are undocumented, so a page's batch aborts through a CHECK
-- constraint instead: inserting into this table fails, rolling back the whole batch,
-- whenever the guarded cursor update before it changed nothing.
CREATE TABLE cursor_guard (x INTEGER CHECK (x = 0));

CREATE TABLE takedowns (
  key    TEXT PRIMARY KEY,               -- cast hash, upload hash or remote URL
  kind   TEXT NOT NULL,
  ts     INTEGER NOT NULL,
  reason TEXT
) WITHOUT ROWID;
