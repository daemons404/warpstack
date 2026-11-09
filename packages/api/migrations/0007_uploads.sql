-- Images members post (uploads). Not rebuildable: a cast signs its
-- image's URL, so an upload is kept for as long as casts may name it.
CREATE TABLE uploads (
  sha256  TEXT PRIMARY KEY,              -- of the bytes uploaded, so takedowns match content
  key     TEXT NOT NULL,                 -- the R2 key: u/{sha256}/{width}
  fid     INTEGER NOT NULL,              -- who uploaded it
  width   INTEGER NOT NULL,
  height  INTEGER NOT NULL,
  ts      INTEGER NOT NULL
) WITHOUT ROWID;
CREATE INDEX uploads_key ON uploads(key);
