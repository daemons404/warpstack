import type { IngestionObject } from './ingestion.ts'
import type { UserObject } from './user-object.ts'

/** Bindings and variables the Worker needs. `config.ts` parses them at startup. */
export interface Env {
  DB: D1Database
  INGEST: DurableObjectNamespace<IngestionObject>
  /** One user object per FID, named by the FID. */
  USER: DurableObjectNamespace<UserObject>
  READ_IP: RateLimit
  UPSTREAM_IP: RateLimit
  /** Writes per FID, counted only after the message's signature checks out. */
  WRITE_FID: RateLimit
  /** The Snapchain node, e.g. https://snap.farcaster.xyz:3381, or a pool of them separated by commas, tried in that order. */
  SNAPCHAIN_URL: string
  /** Optional Cloudflare Access service token for our own nodes, as `id:secret`, shared by every node in the pool. */
  SNAPCHAIN_ACCESS_TOKEN?: string
  /** `farcaster` (the client API, with the seeded list as fallback) or `seeded`. */
  CHANNEL_REGISTRY?: string
  /** The emergency switch: `true` stops lazy upstream reads; cached and indexed reads keep working. */
  READ_ONLY?: string
  /** How far back a new deployment fills the index, in hours. Unset: everything the node still holds. */
  INGEST_BACKFILL_HOURS?: string
  /** How many days the cast index keeps casts: 28 unless set, at most 90. */
  RETENTION_DAYS?: string
  /** Secret, at least 32 characters: MACs cursors. */
  CURSOR_MAC_KEY: string
  /** Secret, at least 32 characters: MACs session challenges and tokens. */
  SESSION_MAC_KEY: string
  /** The origin the phone signs session challenges for, e.g. `https://warpstack.example`. */
  CANONICAL_ORIGIN: string
  /** `appFid` accepts sessions only from keys the app FID requested. Unset: any active key. */
  ACCEPT_SESSION_KEYS_FROM?: string
  /** The app FID, for `ACCEPT_SESSION_KEYS_FROM=appFid` and, later, key requests. Unset in v1. */
  APP_FID?: string
  /** R2: re-encoded avatars, proxied images and, later, uploads. Shared with the media Worker. */
  MEDIA?: R2Bucket
  /** Cloudflare Images: every image is decoded and re-encoded here before it is stored. */
  IMAGES?: ImagesBinding
  /** Untrusted fetches across the deployment, counted under one key: the cost guard. */
  FETCH_ALL?: RateLimit
  /**
   * Who may use this deployment. Unset or `private`: only signed-in, allowed users, meaning a FID
   * in ALLOWED_FIDS or, with APP_FID, anyone whose key the app FID requested. `public`: anyone,
   * with anonymous reads (the design's open client).
   */
  ACCESS?: string
  /** The FIDs allowed to use a private deployment, comma-separated, e.g. `1234, 42`. */
  ALLOWED_FIDS?: string
  /** Secret, at least 32 characters: MACs the media tokens that open avatars and proxied images. Shared with the media Worker. */
  MEDIA_KEY?: string
  /** The media Worker's origin, e.g. `https://warpstack-media.you.workers.dev`. Unset: no images. */
  MEDIA_ORIGIN?: string
}
