-- M1.5: notifications read replies and recasts by the FID they target, and the home feed
-- reads each signed-in account's follows from a short-lived cache rather than paging the
-- node on every request.

CREATE INDEX IF NOT EXISTS casts_parent_fid ON casts(parent_fid, ts DESC) WHERE parent_fid IS NOT NULL;
CREATE INDEX IF NOT EXISTS recasts_target_fid ON recasts(target_fid, ts DESC);

CREATE TABLE IF NOT EXISTS following_cache (
  fid      INTEGER PRIMARY KEY,
  fids     TEXT NOT NULL,                -- JSON array of followed FIDs
  complete INTEGER NOT NULL,             -- 0 when the read stopped at its bound
  ts       INTEGER NOT NULL
);
