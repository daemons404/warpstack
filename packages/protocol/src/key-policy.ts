import { toHex } from './bytes.ts'

// What an app key may be: the scopes and lifetime the vault grants, and the fingerprint people
// compare between screens. The phone's Rust vault holds the same constants (its scopes and TTL
// are fixed there, not passed in); `wallet/vectors/native.json` pins both to the same bytes.

/** Message type numbers, as `messages.ts` names them, kept here so this file needs no encoder. */
const CAST_ADD = 1, CAST_REMOVE = 2, REACTION_ADD = 3, REACTION_REMOVE = 4, LINK_ADD = 5, LINK_REMOVE = 6, USER_DATA_ADD = 11

/** What an app key may sign: posting, reacting, following and profile edits. Never keys, verifications or storage. */
export const POSTING_SCOPES: readonly number[] = [CAST_ADD, CAST_REMOVE, REACTION_ADD, REACTION_REMOVE, LINK_ADD, LINK_REMOVE, USER_DATA_ADD]

export const SCOPE_NAMES: Record<number, string> = {
  [CAST_ADD]: 'post casts',
  [CAST_REMOVE]: 'delete casts',
  [REACTION_ADD]: 'like and recast',
  [REACTION_REMOVE]: 'undo likes and recasts',
  [LINK_ADD]: 'follow',
  [LINK_REMOVE]: 'unfollow',
  [USER_DATA_ADD]: 'edit the profile, including which verified address is primary',
}

/** An app key lives 30 days from its last use (sliding), well under the protocol's 90. */
export const APP_KEY_TTL_SECONDS = 30 * 86_400
/** How far ahead a custody signature's deadline may be. */
export const REQUEST_WINDOW_SECONDS = 60 * 60

/**
 * A fingerprint of a public key, the same in the app and the vault's sheet, so the person can
 * match them: 80 bits in five groups.
 */
export const keyFingerprint = (key: Uint8Array): string =>
  (toHex(key).slice(2, 22).toUpperCase().match(/.{4}/g) ?? []).join('-')
