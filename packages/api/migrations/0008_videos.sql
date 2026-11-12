-- Videos members upload to the deployment's own Cloudflare Stream. Not rebuildable: a cast
-- names a video's playlist, so the row is kept for as long as casts may. It also counts uploads
-- per member and per day, since each one costs the owner money.
CREATE TABLE videos (
  id        TEXT PRIMARY KEY,              -- Stream's uid
  fid       INTEGER NOT NULL,              -- who started the upload
  status    TEXT NOT NULL,                 -- 'processing', 'ready' or 'failed'
  hls       TEXT,                          -- the playlist URL, once ready
  width     INTEGER,
  height    INTEGER,
  duration  REAL,
  poster    TEXT,                          -- the media key of the re-encoded poster, if any
  poster_w  INTEGER,
  poster_h  INTEGER,
  ts        INTEGER NOT NULL               -- when the upload was started
) WITHOUT ROWID;
CREATE INDEX videos_fid_ts ON videos(fid, ts);
CREATE INDEX videos_ts ON videos(ts);
CREATE UNIQUE INDEX videos_hls ON videos(hls) WHERE hls IS NOT NULL;
