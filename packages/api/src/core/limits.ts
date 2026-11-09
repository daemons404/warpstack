// Named limits for the backend. Route and schema limits live in
// the contract's `LIMITS`.
export const API_LIMITS = {
  /** Snapchain's page size for `/v1/events`. */
  EVENTS_PAGE: 1_000,
  /** Bounds one ingestion alarm. */
  MAX_PAGES_PER_TICK: 10,
  /** A cursor past confirmation-only pages commits at most this often. */
  QUIET_COMMIT_SECONDS: 60,
  /** Cast index retention. */
  RETENTION_DAYS: 28,
  /** Rows deleted per prune statement. */
  PRUNE_BATCH: 1_000,
  /** Prune batches per cron run, so one run stays well inside the CPU limit. */
  PRUNE_BATCHES_PER_RUN: 50,
  /** Profile fills from `userData` in one request, so one page can't fan out without bound. */
  MAX_FILLS: 50,
  FILL_CONCURRENCY: 8,
  /** Quoted casts read upstream in one request. */
  MAX_QUOTE_READS: 10,
  /** Pages read to count followers or following; past them a count is a lower bound. */
  FOLLOW_COUNT_PAGES: 5,
  FOLLOW_COUNT_PAGE_SIZE: 100,
  /** How long bounded follower counts are reused, in seconds. */
  FOLLOW_COUNT_TTL: 86_400,
  /** One bounded page per count for a cast older than the index. */
  LAZY_COUNT_PAGE: 100,
  /** Upstream pages one profile request may read when filtering leaves a page short. */
  MAX_UPSTREAM_PAGES: 3,
  /** Past this lag, profiles read Snapchain directly rather than an index that is catching up. */
  INDEX_LAG_TOLERANCE_SECONDS: 300,
  /** How long a FID's follow list is reused for its home feed and viewer state, in seconds. */
  FOLLOWING_TTL: 600,
  /** Follows read for a home feed; past this the feed covers the first ones read. */
  MAX_FOLLOWING: 5_000,
  FOLLOWING_PAGE: 1_000,
  /** How far back the home feed reads, so one page never sorts a month of every followed account's casts. */
  HOME_DAYS: 7,
  /** Each kind of notification read per request. */
  NOTIFICATIONS_PER_KIND: 25,
  /** Casts read from Snapchain for one notifications page, when they're outside the index. */
  NOTIFICATION_UPSTREAM_CASTS: 10,
  /** The one-time inbox fill: own casts whose likes, recasts and replies are read, and page sizes. */
  INBOX_FILL_CASTS: 15,
  INBOX_FILL_PAGE: 100,
  INBOX_FILL_CONCURRENCY: 6,
  /** A viewer's own recent reactions read per kind. */
  VIEWER_REACTIONS: 1_000,
  /** Alarm delays, in milliseconds. */
  POLL_MS: 1_000,
  BEHIND_MS: 50,
  BACKOFF_MS: 60_000,
} as const
