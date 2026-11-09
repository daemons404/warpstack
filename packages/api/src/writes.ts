import { admits, type Admission } from './config.ts'
import { keyAddRequestFid } from './core/key-add.ts'
import { err, fromBase64Url, MessageType, ok, POSTING_SCOPES, toFarcasterTime, verifyMessage, type Result } from '@warpstack/protocol'
import type { Clock, Snapchain } from './ports.ts'

// The write path: a per-IP limit (the router's), then decode, verify the
// envelope and signature, and only then, with the FID trustworthy, the per-FID limit and the
// session check: every type but `KEY_ADD` needs a session whose FID is the message's. The node
// checks that the signer is a live key with the type in its scopes, and bad messages never
// reach the network.

export type WriteError =
  | { kind: 'bad_input'; detail: string }
  | { kind: 'rejected'; detail: string }
  /** A message other than `KEY_ADD` without a session. */
  | { kind: 'no_session' }
  /** The session belongs to another FID. */
  | { kind: 'fid_mismatch' }
  | { kind: 'rate_limited' }
  /** The node doesn't know the signer: the key expired or was revoked. */
  | { kind: 'key_inactive' }
  | { kind: 'read_only' }
  | { kind: 'upstream'; detail: string }

/** What an app key may submit: posting messages, its own registration, and key removals. */
const SUBMITTABLE = new Set<number>([...POSTING_SCOPES, MessageType.KEY_ADD, MessageType.KEY_REMOVE])

/** Snapchain refuses messages more than ten minutes ahead; this refuses them before the node does, and stale ones too. */
const MAX_SKEW_SECONDS = 10 * 60
const MAX_AGE_SECONDS = 60 * 60

/** Who is submitting: the session's FID, if the request carried a valid session. */
export type Submitter = { sessionFid: number | null; limitFid: (fid: number) => Promise<boolean> }

export class Writes {
  constructor(
    private readonly snapchain: Snapchain,
    private readonly clock: Clock,
    private readonly readOnly: boolean,
    /** Relay anyone's messages without a session. Off by default. */
    private readonly openRelay = false,
    /** Whose `KEY_ADD`s a private deployment relays: allowed FIDs, or keys the app FID requested. */
    private readonly admission: Admission = { public: true, allowed: new Set() },
  ) {}

  async submit(encoded: string, who: Submitter): Promise<Result<{ hash: string }, WriteError>> {
    if (this.readOnly) return err({ kind: 'read_only' })
    const bytes = fromBase64Url(encoded)
    if (!bytes) return err({ kind: 'bad_input', detail: 'message must be base64url' })
    const v = verifyMessage(bytes)
    if (!v.ok) return err({ kind: 'rejected', detail: v.error })
    const m = v.value
    // `KEY_ADD` is the one message relayed without a session, so a private deployment relays it
    // only for its own people, read from the message itself before anything reaches the node.
    if (m.type === MessageType.KEY_ADD && !admits(this.admission, m.fid, keyAddRequestFid(m.dataBytes) ?? undefined)) {
      return err({ kind: 'rejected', detail: 'this deployment does not accept keys for this FID' })
    }
    // Only now is the FID trustworthy: a garbage message claiming a victim's FID never spends their budget.
    if (!(await who.limitFid(m.fid))) return err({ kind: 'rate_limited' })
    if (!SUBMITTABLE.has(m.type)) return err({ kind: 'rejected', detail: 'this deployment does not submit that message type' })
    if (m.type !== MessageType.KEY_ADD && !this.openRelay) {
      if (who.sessionFid === null) return err({ kind: 'no_session' })
      if (who.sessionFid !== m.fid) return err({ kind: 'fid_mismatch' })
    }
    const now = toFarcasterTime(this.clock.now())
    if (m.timestamp > now + MAX_SKEW_SECONDS || m.timestamp < now - MAX_AGE_SECONDS) {
      return err({ kind: 'rejected', detail: 'the message timestamp is off; check this device\'s clock' })
    }
    const r = await this.snapchain.submitMessage(bytes)
    if (!r.ok) {
      if (r.error.kind !== 'rejected') return err({ kind: 'upstream', detail: r.error.detail })
      return err(/invalid signer|unknown signer/i.test(r.error.detail) ? { kind: 'key_inactive' } : r.error)
    }
    return ok({ hash: m.hash })
  }
}
