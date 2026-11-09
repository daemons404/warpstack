-- Images. Every image a phone sees was fetched once by the
-- Worker, checked, re-encoded by Cloudflare's Images binding and stored in R2; these rows
-- say what is stored for which remote URL, so nothing is fetched or transformed twice.

CREATE TABLE media_sources (
  src     TEXT NOT NULL,                 -- the remote URL, as a profile or a page names it
  kind    TEXT NOT NULL,                 -- 'avatar' (square, small) or 'image' (up to 1,080 wide)
  status  TEXT NOT NULL,                 -- 'ok' or 'failed'
  key     TEXT,                          -- the R2 key, when stored
  width   INTEGER,
  height  INTEGER,
  sha256  TEXT,                          -- of the bytes fetched, so takedowns match content
  ts      INTEGER NOT NULL,              -- when stored, or when it last failed
  PRIMARY KEY (src, kind)
) WITHOUT ROWID;

-- What a URL embed is, by URL: an image, a link card, or unknown. Failures are kept briefly
-- so a broken URL isn't refetched on every view.
CREATE TABLE embed_meta (
  url   TEXT PRIMARY KEY,
  ok    INTEGER NOT NULL,
  json  TEXT NOT NULL,
  ts    INTEGER NOT NULL
) WITHOUT ROWID;
