// Bounds both ends enforce. Schemas reference them, so
// each is checked at parse time on both sides.
export const LIMITS = {
  /** Actors named in one notification group, newest first. */
  groupActors: 10,
  pageSize: 25,
  userBulk: 100,
  searchQuery: { min: 2, max: 32 },
  searchResults: 10,
  castBytes: { cast: 320, long: 1_024, tenK: 10_000 },
  mentions: 10,
  embeds: 4,
  ancestors: 5,
  cursorBytes: 512,
  verifications: 50,
  moderators: 50,
} as const

/** The largest image the device may upload: it resizes and re-encodes before sending, so 4 MB is plenty. */
export const MEDIA_UPLOAD_MAX_BYTES = 4 * 1_024 * 1_024
