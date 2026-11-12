import { MESSAGE_LIMITS, type CastRef, type Embed, type MessageBody } from '@warpstack/protocol'

// Drafts into `CastAdd` bodies: mentions are taken out of the text
// and recorded with their UTF-8 byte positions, as the protocol stores them, and the first
// links become embeds so other clients show previews.

export type Draft = {
  text: string
  /** A reply's parent cast, or a channel's parent URL. */
  parent?: CastRef | { url: string } | undefined
  quote?: CastRef | undefined
  /** Image URLs from media.upload, on the deployment's media origin. Embedded first. */
  images?: string[] | undefined
  /** A video's playlist URL from video.status, on the deployment's own Stream. Embedded first. */
  video?: string | undefined
}

const MENTION = /(^|[\s(])@([a-z0-9][a-z0-9-]{0,15}(?:\.eth)?)(?![a-z0-9-]|\.[a-z0-9])/gi
const URL_IN_TEXT = /https:\/\/[^\s<>"']+/g

const utf8 = (s: string) => new TextEncoder().encode(s).length

/**
 * What's wrong with a draft before anything is uploaded or signed, or null. Images and a quote
 * are embeds, and a cast holds at most `MESSAGE_LIMITS.embeds`; links in the text become
 * embeds only while there's room.
 */
export const draftProblem = (draft: Pick<Draft, 'images' | 'quote' | 'video'>): string | null => {
  const attached = (draft.video ? 1 : 0) + (draft.images?.length ?? 0) + (draft.quote ? 1 : 0)
  return attached > MESSAGE_LIMITS.embeds
    ? `A cast holds at most ${MESSAGE_LIMITS.embeds} attachments: a video, images and a quoted cast together.`
    : null
}

/**
 * Builds the body. `resolve` maps a username to its FID, or null; usernames that don't
 * resolve stay in the text as typed. At most ten mentions and two embeds, as the protocol allows.
 */
export const prepareCast = async (draft: Draft, resolve: (username: string) => Promise<number | null>): Promise<MessageBody & { type: 'castAdd' }> => {
  const found = [...draft.text.matchAll(MENTION)].slice(0, MESSAGE_LIMITS.mentions)
  const names = [...new Set(found.map(m => (m[2] as string).toLowerCase()))]
  const fids = new Map<string, number>()
  await Promise.all(names.map(async n => {
    const fid = await resolve(n).catch(() => null)
    if (fid) fids.set(n, fid)
  }))

  let text = ''
  let last = 0
  const mentions: number[] = []
  const mentionsPositions: number[] = []
  for (const m of found) {
    const name = (m[2] as string).toLowerCase()
    const fid = fids.get(name)
    if (!fid) continue
    const at = (m.index as number) + (m[1] as string).length
    text += draft.text.slice(last, at)
    mentions.push(fid)
    mentionsPositions.push(utf8(text))
    last = at + 1 + (m[2] as string).length
  }
  text += draft.text.slice(last)

  const embeds: Embed[] = []
  const problem = draftProblem(draft)
  if (problem) throw new RangeError(problem)
  if (draft.video) embeds.push({ url: draft.video })
  for (const url of draft.images ?? []) embeds.push({ url })
  if (draft.quote) embeds.push({ cast: draft.quote })
  for (const url of new Set(draft.text.match(URL_IN_TEXT) ?? [])) {
    const clean = url.replace(/[.,;:!?)\]]+$/, '')
    if (embeds.length < MESSAGE_LIMITS.embeds && utf8(clean) <= MESSAGE_LIMITS.embedUrl) embeds.push({ url: clean })
  }
  return { type: 'castAdd', text: text.trim() === '' && embeds.length ? '' : text, mentions, mentionsPositions, embeds, ...(draft.parent ? { parent: draft.parent } : {}) }
}
