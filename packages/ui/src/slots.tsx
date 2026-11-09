import { castSegments, embedView, relativeTime, toWarpError, type WarpError } from '@warpstack/client'
import { useAccount, useCastActions, useDeleteCast, useEmbed, useMediaUrl, type ListState } from '@warpstack/client/react'
import type { Cast, EmbedMetadata, QuotedCast, User, UserSummary } from '@warpstack/contract'
import { routes } from '@warpstack/app-core'
import { Image as MediaImage } from 'expo-image'
import { Link, useRouter } from 'expo-router'
import { useEffect, useState, type ReactNode } from 'react'
import { ActivityIndicator, Image, Linking, Platform, Pressable, StyleSheet, Text, View, type TextStyle } from 'react-native'
import { HeartIcon, LinkIcon, MoreIcon, PencilIcon, RecastIcon, ReplyIcon, XIcon } from './icons.tsx'
import { ActionSheet } from './sheet.tsx'
import { AVATAR, HIT, HUES, radius, space, type, useColors } from './theme.ts'

// Slots: the pieces screens are built from. Images only ever come from the deployment's media
// origin, as MediaKeys the server fetched and re-encoded; the app never loads a URL someone
// posted. Without a media origin, or while an image isn't stored yet, avatars are initials and
// image embeds are links the reader chooses to open.

const now = () => Math.floor(Date.now() / 1_000)
export const nameOf = (u: UserSummary | User) => u.displayName || u.username || `fid:${u.fid}`

/** Tries to load an image the server is still storing: it usually lands within seconds. */
const MEDIA_RETRIES_MS = [1_500, 3_000, 6_000, 12_000]

/**
 * A stored image's URL to show, retried a few times while the server finishes storing it.
 * Null when there's none, while it waits between tries, or once it gives up: show a fallback.
 */
export const useStoredImage = (key: string | undefined | null): { uri: string; onError: () => void; tries: number } | null => {
  const src = useMediaUrl(key)
  const [attempt, setAttempt] = useState({ src, n: 0, waiting: false })
  // A new image starts over.
  if (attempt.src !== src) setAttempt({ src, n: 0, waiting: false })
  useEffect(() => {
    if (!attempt.waiting) return
    const t = setTimeout(() => setAttempt(a => ({ ...a, waiting: false })), MEDIA_RETRIES_MS[attempt.n - 1] ?? 0)
    return () => clearTimeout(t)
  }, [attempt])
  if (!src || attempt.waiting || attempt.n > MEDIA_RETRIES_MS.length) return null
  return {
    uri: attempt.n ? `${src}${src.includes('?') ? '&' : '?'}try=${attempt.n}` : src,
    tries: attempt.n,
    onError: () => setAttempt(a => (a.waiting ? a : { ...a, n: a.n + 1, waiting: a.n < MEDIA_RETRIES_MS.length })),
  }
}

export const Avatar = ({ user, size }: { user: { fid: number; displayName?: string | undefined; username?: string | undefined; pfp?: string | undefined }; size: number }) => {
  const image = useStoredImage(user.pfp)
  const label = (user.displayName || user.username || String(user.fid)).replace(/^[^\p{L}\p{N}]+/u, '')
  const initial = ([...label][0] ?? '?').toUpperCase()
  if (image) {
    return (
      <Image key={image.tries} source={{ uri: image.uri }} onError={image.onError}
        accessibilityElementsHidden importantForAccessibility="no"
        style={{ width: size, height: size, borderRadius: size / 2, backgroundColor: HUES[user.fid % HUES.length] }} />
    )
  }
  return (
    <View accessibilityElementsHidden importantForAccessibility="no-hide-descendants"
      style={{ width: size, height: size, borderRadius: size / 2, backgroundColor: HUES[user.fid % HUES.length], alignItems: 'center', justifyContent: 'center' }}>
      <Text allowFontScaling={false} style={{ color: '#fff', fontWeight: '600', fontSize: size * 0.42 }}>{initial}</Text>
    </View>
  )
}

/** A link out of the app: a real anchor on the web, the system browser on the phone. */
export const ExternalLink = ({ url, children, style }: { url: string; children: ReactNode; style?: TextStyle | undefined }) => {
  const c = useColors()
  const web = Platform.OS === 'web'
    ? { href: url, hrefAttrs: { target: '_blank', rel: 'noopener noreferrer nofollow' } } as object
    : { onPress: () => void Linking.openURL(url) }
  return <Text accessibilityRole="link" style={[{ color: c.accent }, style]} {...web}>{children}</Text>
}

const utf8 = new TextEncoder()

/**
 * The text to show: a URL at the very end is dropped when it's shown as an embed below, as
 * the Farcaster client does. Kept when that would cut off a mention.
 */
const shownText = (cast: Cast): Pick<Cast, 'text' | 'mentions'> => {
  const text = cast.text.trimEnd()
  for (const e of cast.embeds) {
    const v = embedView(e)
    if (!v || v.kind === 'cast') continue
    for (const form of [v.url, v.url.replace(/^https?:\/\//, '')]) {
      if (!text.endsWith(form)) continue
      const cut = text.slice(0, -form.length).trimEnd()
      const bytes = utf8.encode(cut).length
      if (cast.mentions.every(m => m.pos <= bytes)) return { text: cut, mentions: cast.mentions }
    }
  }
  return cast
}

export const CastText = ({ cast, large }: { cast: Pick<Cast, 'text' | 'mentions'>; large?: boolean }) => {
  const c = useColors()
  const base = [type.body, large && { fontSize: 17, lineHeight: 24 }, { color: c.text }]
  if (!cast.text) return null
  return (
    <Text style={base} selectable>
      {castSegments(cast).map((s, i) => {
        switch (s.kind) {
          case 'text': return <Text key={i}>{s.text}</Text>
          case 'mention': return (
            <Link key={i} href={routes.profile(s.fid)} style={{ color: c.accent }}>@{s.username ?? `fid:${s.fid}`}</Link>
          )
          case 'channel': return <Link key={i} href={routes.channel(s.key)} style={{ color: c.accent }}>/{s.key}</Link>
          case 'link': return <ExternalLink key={i} url={s.url}>{s.text}</ExternalLink>
        }
      })}
    </Text>
  )
}

const QuoteCard = ({ cast }: { cast: QuotedCast }) => {
  const c = useColors()
  return (
    <Link href={routes.thread(cast)} asChild>
      {/* The styles sit on an inner View: Link's asChild can't merge a style function. */}
      <Pressable accessibilityRole="link">
        {({ pressed }) => (
          <View style={[styles.quote, { borderColor: c.border }, pressed && { backgroundColor: c.pressed }]}>
            <View style={styles.row}>
              <Avatar user={cast.author} size={20} />
              <Text style={[type.small, { color: c.text, fontWeight: '600', flexShrink: 1 }]} numberOfLines={1}>{nameOf(cast.author)}</Text>
              {cast.author.username && <Text style={[type.small, { color: c.muted, flexShrink: 1 }]} numberOfLines={1}>@{cast.author.username}</Text>}
            </View>
            <Text style={[type.small, { color: c.text, fontSize: 14, lineHeight: 20 }]} numberOfLines={5}>{cast.text}</Text>
          </View>
        )}
      </Pressable>
    </Link>
  )
}

/** A link the server hasn't described (yet, or ever): a chip the reader chooses to open. */
const LinkChip = ({ url, label }: { url: string; label: string }) => {
  const c = useColors()
  return (
    <View style={[styles.chip, { borderColor: c.border, backgroundColor: c.field }]}>
      <ExternalLink url={url} style={{ ...type.small, color: c.text }}>{label} ↗</ExternalLink>
    </View>
  )
}

/** The tallest an image embed gets in a list, as in the Farcaster client. */
const MAX_IMAGE_HEIGHT = 400
/** Link cards' image slot: the Open Graph shape. */
const OG_ASPECT = 1.91

/**
 * A stored image at its own aspect ratio, capped in height. expo-image, not React Native's
 * Image: it plays animated WebP, which is what a GIF is once the server has re-encoded it.
 */
const StoredImage = ({ media, width, height }: { media: string; width: number; height: number }) => {
  const c = useColors()
  const src = useMediaUrl(media)
  if (!src) return null
  return (
    <MediaImage source={{ uri: src }} recyclingKey={src} accessibilityIgnoresInvertColors contentFit="cover" transition={0}
      style={{ width: '100%', aspectRatio: width / height, maxHeight: MAX_IMAGE_HEIGHT, borderRadius: radius.md, backgroundColor: c.field }} />
  )
}

/** Opens a URL from a whole card: a real anchor on the web, the system browser on the phone. */
const linkProps = (url: string) => (Platform.OS === 'web'
  ? { href: url, hrefAttrs: { target: '_blank', rel: 'noopener noreferrer nofollow' } } as object
  : { onPress: () => void Linking.openURL(url) })

const bareDomain = (d: string) => (d.startsWith('www.') ? d.slice(4) : d)

/**
 * A link card, as the Farcaster client draws one: the preview image in a 1.91:1 slot (or a
 * plain panel with a link mark when there's none), then the domain and up to two lines of
 * title. The domain is the URL's own, never what the page claims about itself.
 */
const LinkCard = ({ url, meta }: { url: string; meta: LinkMeta }) => {
  const c = useColors()
  const src = useMediaUrl(meta.image?.media)
  return (
    <Pressable accessibilityRole="link" accessibilityLabel={`${meta.title ?? meta.domain}, ${bareDomain(meta.domain)}`} {...linkProps(url)}>
      {({ pressed }) => (
        <View style={[styles.linkCard, { borderColor: c.border, backgroundColor: pressed ? c.pressed : c.surface }]}>
          {src
            ? <MediaImage source={{ uri: src }} recyclingKey={src} accessibilityIgnoresInvertColors contentFit="cover" transition={0}
                style={{ width: '100%', aspectRatio: OG_ASPECT, backgroundColor: c.field }} />
            : <View style={[styles.linkPanel, { backgroundColor: c.field }]}><LinkIcon color={c.muted} size={28} /></View>}
          <View style={[styles.linkText, { borderTopColor: c.border }]}>
            <Text style={[type.body, { color: c.muted }]} numberOfLines={1}>{bareDomain(meta.domain)}</Text>
            {meta.title && <Text style={[type.body, { color: c.text }]} numberOfLines={2}>{meta.title}</Text>}
          </View>
        </View>
      )}
    </Pressable>
  )
}

const isX = (domain: string) => domain === 'x.com' || domain === 'twitter.com' || domain.endsWith('.twitter.com')

/** "Name (@handle) on X" or "... on Twitter", as X titles its posts. */
const xAuthor = (title: string) => {
  const head = title.split(/ on (?:X|Twitter)\s*$/)[0]!.trim()
  const m = /^(.*) \(@([A-Za-z0-9_]{1,15})\)$/.exec(head)
  return m ? { name: m[1]!, handle: m[2] } : { name: head, handle: undefined }
}

/** A post on X, as the Farcaster client quotes one: X's mark, who posted, and the text. */
const XPostCard = ({ url, title, text }: { url: string; title: string; text: string }) => {
  const c = useColors()
  const who = xAuthor(title)
  return (
    <Pressable accessibilityRole="link" accessibilityLabel={`Post on X by ${who.name}`} {...linkProps(url)}>
      {({ pressed }) => (
        <View style={[styles.xCard, { borderColor: c.border, backgroundColor: pressed ? c.pressed : c.surface }]}>
          <View style={styles.row}>
            <XIcon color={c.muted} size={12} />
            <Text style={[type.name, { color: c.text, flexShrink: 1 }]} numberOfLines={1}>
              {who.name}{who.handle && <Text style={[type.meta, { color: c.muted, fontWeight: '400' }]}> @{who.handle}</Text>}
            </Text>
          </View>
          <Text style={[type.body, { color: c.text }]} numberOfLines={5}>{text}</Text>
        </View>
      )}
    </Pressable>
  )
}

/**
 * One URL embed, described by the server: an image it re-encoded (animated if the source
 * was), a post on X, or a link card. Until then, or if it can't say, the link stays a chip.
 */
type ImageMeta = Extract<EmbedMetadata, { kind: 'image' }>
type LinkMeta = Extract<EmbedMetadata, { kind: 'link' }>
const isImage = (m: EmbedMetadata | undefined): m is ImageMeta => m?.kind === 'image' && 'media' in m
const isLink = (m: EmbedMetadata | undefined): m is LinkMeta => m?.kind === 'link' && 'domain' in m

const UrlEmbed = ({ cast, index, url, host, fallback }: { cast: Cast; index: number; url: string; host: string; fallback: string }) => {
  const meta = useEmbed(cast, index)
  const m = meta.data
  if (isImage(m)) return <StoredImage media={m.media} width={m.width} height={m.height} />
  if (isLink(m) && isX(m.domain) && m.title && m.description) return <XPostCard url={url} title={m.title} text={m.description} />
  if (isLink(m) && (m.title || m.image)) return <LinkCard url={url} meta={m} />
  return <LinkChip url={url} label={m && 'domain' in m ? String(m.domain) : m ? host : fallback} />
}

const Embeds = ({ cast }: { cast: Cast }) => {
  const c = useColors()
  const views = cast.embeds.map((e, index) => ({ index, view: embedView(e) })).filter(v => v.view !== null)
  if (!views.length) return null
  return (
    <View style={styles.embedStack}>
      {views.map(({ index, view: v }) => {
        if (v!.kind === 'cast') {
          return v!.cast
            ? <QuoteCard key={index} cast={v!.cast} />
            : <View key={index} style={[styles.chip, { borderColor: c.border }]}><Text style={[type.small, { color: c.muted }]}>Quoted cast unavailable</Text></View>
        }
        const label = v!.kind === 'image' ? `Image · ${v!.host}` : v!.kind === 'video' ? `Video · ${v!.host}` : v!.host
        // Video isn't played in-app yet; it stays a link.
        if (v!.kind === 'video') return <LinkChip key={index} url={v!.url} label={label} />
        return <UrlEmbed key={index} cast={cast} index={index} url={v!.url} host={v!.host} fallback={label} />
      })}
    </View>
  )
}

const count = (n: number, exact: boolean) => (n === 0 ? '' : `${n.toLocaleString()}${exact ? '' : '+'}`)

// The Farcaster client's action colors: green for your recast, crimson for your like.
const RECASTED = '#14ae5c'

type ActionIcon = (p: { color: string }) => ReactNode

export type Emphasis = 'root' | 'ancestor' | 'default'

/** A cast. Tapping it opens its thread; its timestamp is a real link, for keyboards and new tabs. */
export const CastCard = ({ cast, emphasis = 'default', threadRoot }: { cast: Cast; emphasis?: Emphasis; threadRoot?: string }) => {
  const c = useColors()
  const router = useRouter()
  const open = () => {
    if (emphasis === 'root') return
    // Selecting text on the web shouldn't navigate away.
    if (Platform.OS === 'web' && typeof window !== 'undefined' && String(window.getSelection?.() ?? '').length > 0) return
    router.push(routes.thread(cast))
  }
  const parent = cast.parent
  const root = emphasis === 'root'
  if (root) return <FocusedCast cast={cast} threadRoot={threadRoot} />
  return (
    // Not one accessibility element: VoiceOver reaches the name, text, links and actions one by
    // one, and the timestamp link opens the thread.
    <Pressable onPress={open} disabled={root} accessible={false}
      style={({ pressed }) => [styles.cast, { borderBottomColor: c.border, borderBottomWidth: emphasis === 'ancestor' ? 0 : StyleSheet.hairlineWidth },
        emphasis === 'ancestor' && { paddingBottom: 0 }, pressed && !root && { backgroundColor: c.pressed }]}>
      <View style={{ alignItems: 'center' }}>
        {/* asChild: a Link renders as text on iOS, which would lay the image out on a text baseline and clip it. */}
        <Link href={routes.profile(cast.fid)} asChild>
          <Pressable accessibilityRole="link" accessibilityLabel={`${nameOf(cast.author)}'s profile`}>
            <Avatar user={cast.author} size={AVATAR} />
          </Pressable>
        </Link>
        {emphasis === 'ancestor' && <View style={[styles.rail, { backgroundColor: c.border }]} />}
      </View>
      <View style={{ flex: 1, minWidth: 0, paddingBottom: emphasis === 'ancestor' ? space.md : 0 }}>
        {/* Inside a thread, a reply to the thread's root needs no "Replying to". */}
        {parent && emphasis !== 'ancestor' && !(parent.kind === 'cast' && parent.ref.hash === threadRoot) && (
          <Text style={[type.small, { color: c.muted, marginBottom: space.xxs }]} numberOfLines={1}>
            {parent.kind === 'cast'
              ? <>Replying to <Link href={routes.thread(parent.ref)} style={{ color: c.accent }}>a cast</Link></>
              : parent.kind === 'channel' ? <>in <Link href={routes.channel(parent.key)} style={{ color: c.accent }}>/{parent.key}</Link></> : null}
          </Text>
        )}
        <View style={[styles.row, { marginBottom: 0 }]}>
          <Link href={routes.profile(cast.fid)} style={StyleSheet.flatten([type.name, { color: c.text, flexShrink: 1 }])} numberOfLines={1}>{nameOf(cast.author)}</Link>
          {cast.author.username && <Text style={[type.meta, { color: c.muted, flexShrink: 2 }]} numberOfLines={1}>@{cast.author.username}</Text>}
          <Text style={[type.meta, { color: c.muted }]}>·</Text>
          <Link href={routes.thread(cast)} style={StyleSheet.flatten([type.meta, { color: c.muted, flexShrink: 0 }])} accessibilityLabel={`Open thread, posted ${new Date(cast.ts * 1_000).toLocaleString()}`}>
            {relativeTime(cast.ts, now())}
          </Link>
        </View>
        <CastText cast={shownText(cast)} large={root} />
        <Embeds cast={cast} />
        <CastFooter cast={cast} root={root} />
      </View>
    </Pressable>
  )
}

/**
 * The cast a thread is about, laid out as the Farcaster client does: avatar beside the name,
 * the text at full width and larger, then the actions, then when it was posted and its counts.
 */
const FocusedCast = ({ cast, threadRoot }: { cast: Cast; threadRoot?: string | undefined }) => {
  const c = useColors()
  const parent = cast.parent
  const when = new Date(cast.ts * 1_000)
  const counts = [
    [cast.counts.recasts, 'Recast', 'Recasts'],
    [cast.counts.likes, 'Like', 'Likes'],
  ] as const
  return (
    <View style={[styles.focused, { borderBottomColor: c.border }]}>
      {parent && !(parent.kind === 'cast' && parent.ref.hash === threadRoot) && (
        <Text style={[type.small, { color: c.muted, marginBottom: space.sm }]} numberOfLines={1}>
          {parent.kind === 'cast'
            ? <>Replying to <Link href={routes.thread(parent.ref)} style={{ color: c.accent }}>a cast</Link></>
            : parent.kind === 'channel' ? <>in <Link href={routes.channel(parent.key)} style={{ color: c.accent }}>/{parent.key}</Link></> : null}
        </Text>
      )}
      <Link href={routes.profile(cast.fid)} asChild>
        <Pressable accessibilityRole="link" accessibilityLabel={`${nameOf(cast.author)}'s profile`} style={styles.focusedHeader}>
          <Avatar user={cast.author} size={AVATAR} />
          <View style={{ flex: 1, minWidth: 0 }}>
            <Text style={[type.name, { color: c.text }]} numberOfLines={1}>{nameOf(cast.author)}</Text>
            {cast.author.username && <Text style={[type.meta, { color: c.muted }]} numberOfLines={1}>@{cast.author.username}</Text>}
          </View>
        </Pressable>
      </Link>
      <CastText cast={shownText(cast)} large />
      <Embeds cast={cast} />
      <View style={{ marginTop: space.sm }}>
        <CastFooter cast={cast} root />
      </View>
      <View style={[styles.details, { borderTopColor: c.border }]}>
        <Text style={[type.small, { color: c.muted }]}>
          {when.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })} · {when.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })}
        </Text>
        {counts.some(([n]) => n > 0) && (
          <Text style={[type.small, { color: c.muted }]}>
            {counts.filter(([n]) => n > 0).map(([n, one, many], i) => (
              <Text key={one}>{i > 0 ? '  ·  ' : ''}<Text style={{ color: c.text, fontWeight: '600' }}>{count(n, cast.counts.exact)}</Text> {n === 1 ? one : many}</Text>
            ))}
          </Text>
        )}
      </View>
    </View>
  )
}

/** Counts for everyone; reply, recast, like and delete buttons once signed in. */
const CastFooter = ({ cast, root }: { cast: Cast; root: boolean }) => {
  const account = useAccount()
  const c = useColors()
  if (account.kind !== 'signedIn') {
    const Static = ({ Icon, n, a11y }: { Icon: ActionIcon; n: number; a11y: string }) => (
      <View style={styles.action} accessible accessibilityLabel={a11y}>
        <Icon color={c.faint} />
        <Text style={[type.small, { color: c.muted }]}>{count(n, cast.counts.exact)}</Text>
      </View>
    )
    return (
      <View style={styles.actions}>
        <Static Icon={ReplyIcon} n={cast.counts.replies} a11y={`${cast.counts.replies} replies`} />
        <Static Icon={RecastIcon} n={cast.counts.recasts} a11y={`${cast.counts.recasts} recasts`} />
        <Static Icon={HeartIcon} n={cast.counts.likes} a11y={`${cast.counts.likes} likes`} />
      </View>
    )
  }
  return <CastActions cast={cast} mine={cast.fid === account.fid} root={root} />
}

/** One action: an icon in the faint color, its count beside it in muted text, both colored when it's yours. */
const Action = ({ Icon, n, a11y, active, activeColor, onPress }: { Icon: ActionIcon; n?: string; a11y: string; active?: boolean; activeColor?: string; onPress: () => void }) => {
  const c = useColors()
  const color = active ? (activeColor ?? c.text) : c.faint
  return (
    <Pressable accessibilityRole="button" accessibilityLabel={a11y} accessibilityState={{ selected: !!active }}
      hitSlop={{ top: 6, bottom: 6 }}
      onPress={e => { e.stopPropagation?.(); onPress() }}
      style={({ pressed }) => [styles.action, pressed && { backgroundColor: c.pressed }]}>
      <Icon color={color} />
      {n !== undefined && <Text style={[type.small, { color: active ? color : c.muted }]}>{n}</Text>}
    </Pressable>
  )
}

const CastActions = ({ cast, mine, root }: { cast: Cast; mine: boolean; root: boolean }) => {
  const c = useColors()
  const router = useRouter()
  const a = useCastActions(cast)
  const remove = useDeleteCast()
  const [confirming, setConfirming] = useState(false)
  const [recastMenu, setRecastMenu] = useState(false)
  const [status, setStatus] = useState<string | null>(null)
  const error = a.like.error ?? a.recast.error
  return (
    <View>
      <View style={styles.actions}>
        <Action Icon={ReplyIcon} n={count(cast.counts.replies, cast.counts.exact)} a11y={`Reply, ${cast.counts.replies} replies`} onPress={() => router.push(routes.compose({ reply: cast }))} />
        {/* As in the Farcaster client, recast opens a menu: recast (or undo it), or quote. */}
        <Action Icon={RecastIcon} n={count(cast.counts.recasts, cast.counts.exact)} a11y={a.recast.on ? 'Recasted. Undo recast or quote' : 'Recast or quote'} active={a.recast.on} activeColor={RECASTED} onPress={() => setRecastMenu(true)} />
        <Action Icon={p => <HeartIcon {...p} filled={a.like.on} />} n={count(cast.counts.likes, cast.counts.exact)} a11y={a.like.on ? 'Unlike' : 'Like'} active={a.like.on} activeColor={c.liked} onPress={() => void a.like.toggle()} />
        {mine && root
          ? <Action Icon={MoreIcon} a11y="Delete this cast" active={confirming} onPress={() => setConfirming(v => !v)} />
          : <View style={styles.action} />}
      </View>
      <ActionSheet open={recastMenu} onClose={() => setRecastMenu(false)} actions={[
        { label: a.recast.on ? 'Undo recast' : 'Recast', Icon: RecastIcon, onPress: () => void a.recast.toggle() },
        { label: 'Quote', Icon: PencilIcon, onPress: () => router.push(routes.compose({ quote: cast })) },
      ]} />
      {confirming && (
        <View style={[styles.confirm, { borderColor: c.border }]}>
          <Text style={[type.small, { color: c.text, flex: 1 }]}>Delete this cast for everyone?</Text>
          <Button label="Cancel" small onPress={() => setConfirming(false)} />
          <Button label="Delete" small tone="danger" onPress={async () => {
            setConfirming(false)
            const r = await remove.run(cast.hash)
            setStatus(r.ok ? 'Deleted. It disappears from lists in a few seconds.' : r.error.message)
          }} />
        </View>
      )}
      {(error || status) && <Text style={[type.small, { color: error ? c.danger : c.muted, marginTop: space.xs }]}>{error?.message ?? status}</Text>}
    </View>
  )
}

export const Message = ({ children, tone = 'muted' }: { children: ReactNode; tone?: 'muted' | 'danger' }) => {
  const c = useColors()
  return <Text style={[type.body, styles.message, { color: tone === 'danger' ? c.danger : c.muted }]}>{children}</Text>
}

/**
 * A button. `primary` fills with the accent; `danger` is for destructive actions; `block`
 * stretches to the container's width; `small` is for inline rows.
 */
export const Button = ({ label, onPress, disabled, tone = 'default', block, small }: {
  label: string; onPress: () => void; disabled?: boolean | undefined; tone?: 'default' | 'primary' | 'danger'; block?: boolean; small?: boolean
}) => {
  const c = useColors()
  // Filled pills, as in the Farcaster client: the accent for the main action, gray for the rest.
  const fill = tone === 'primary' ? { backgroundColor: c.accentFill, borderColor: c.accentFill }
    : tone === 'danger' ? { backgroundColor: c.surface, borderColor: c.danger } : { backgroundColor: c.field, borderColor: c.field }
  const color = tone === 'primary' ? c.accentText : tone === 'danger' ? c.danger : c.text
  return (
    <Pressable accessibilityRole="button" accessibilityState={{ disabled: !!disabled }} onPress={onPress} disabled={disabled}
      hitSlop={small ? { top: 6, bottom: 6 } : undefined}
      style={({ pressed }) => [styles.button, fill, small && styles.buttonSmall, block && { alignSelf: 'stretch' },
        { opacity: disabled ? 0.45 : pressed ? 0.75 : 1 }]}>
      <Text style={[small ? { fontSize: 14, lineHeight: 18 } : type.body, { color, fontWeight: '600' }]}>{label}</Text>
    </Pressable>
  )
}

/** What to tell the person about a failure: the client's own message for it. */
export const describeError = (e: unknown): string => toWarpError(e).message

/** Retrying can't fix these: the thing isn't there, the input is wrong, or the app is out of date. */
const permanent = (e: unknown) => ['notFound', 'invalid', 'update'].includes(toWarpError(e).kind)

/** An error, with a retry only when retrying could help. */
export const ErrorState = ({ error, retry }: { error: WarpError | null | undefined; retry?: (() => Promise<unknown> | void) | undefined }) => (
  <View style={styles.state}>
    <Message tone="danger">{describeError(error)}</Message>
    {retry && !permanent(error) && <Button label="Try again" onPress={() => void Promise.resolve(retry()).catch(() => {})} />}
  </View>
)

export const Loading = () => {
  const c = useColors()
  return <View style={styles.state}><ActivityIndicator color={c.muted} /></View>
}

/** The end of a list: more, a failed page with a retry, the index's horizon, or the end. */
export const ListFooter = ({ list, horizonText }: { list: ListState<unknown>; horizonText: string }) => {
  if (list.moreError) return <ErrorState error={list.moreError} retry={list.loadMore} />
  if (list.loadingMore) return <Loading />
  if (list.hasMore) return <View style={styles.state}><Button label="Load more" onPress={list.loadMore} /></View>
  if (list.horizon && list.items.length) return <Message>{horizonText}</Message>
  return null
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', gap: space.xs, minWidth: 0 },
  // The Farcaster client's cast row: 12 on each side, a 48 avatar, 12 between, a hairline below.
  cast: { flexDirection: 'row', gap: space.md, paddingHorizontal: space.md, paddingTop: space.md, paddingBottom: space.xs },
  focused: { paddingHorizontal: space.md, paddingTop: space.md, paddingBottom: space.xs, borderBottomWidth: StyleSheet.hairlineWidth },
  focusedHeader: { flexDirection: 'row', alignItems: 'center', gap: space.sm, marginBottom: space.md },
  details: { gap: space.xs, paddingTop: space.md, paddingBottom: space.md, marginTop: space.xs, borderTopWidth: StyleSheet.hairlineWidth },
  rail: { width: 2, flex: 1, marginTop: space.xs, borderRadius: 1 },
  embedStack: { gap: space.sm, marginTop: space.sm, alignSelf: 'stretch' },
  // Link cards as in the Farcaster client: a 12-radius frame, the image on top, then the text.
  linkCard: { borderWidth: StyleSheet.hairlineWidth, borderRadius: radius.md, overflow: 'hidden' },
  linkPanel: { width: '100%', aspectRatio: OG_ASPECT, alignItems: 'center', justifyContent: 'center' },
  linkText: { padding: space.md, borderTopWidth: StyleSheet.hairlineWidth },
  xCard: { borderWidth: StyleSheet.hairlineWidth, borderRadius: radius.md, paddingHorizontal: space.md, paddingTop: space.sm, paddingBottom: space.md, gap: space.xxs },
  chip: { borderWidth: StyleSheet.hairlineWidth, borderRadius: radius.full, paddingHorizontal: space.md, paddingVertical: 6, maxWidth: '100%' },
  quote: { borderWidth: StyleSheet.hairlineWidth, borderRadius: radius.md, padding: space.md, gap: space.xs, alignSelf: 'stretch', overflow: 'hidden' },
  // Actions spread across the row with room left at the end, as in the Farcaster client; each
  // keeps a full touch target, and the first lines up with the text above.
  actions: { flexDirection: 'row', justifyContent: 'space-between', marginLeft: -space.sm, marginRight: space.xxl, marginTop: space.xxs },
  action: { flexDirection: 'row', alignItems: 'center', gap: space.xs, minHeight: 36, minWidth: HIT, paddingHorizontal: space.sm, borderRadius: radius.full },
  confirm: { flexDirection: 'row', alignItems: 'center', gap: space.sm, borderWidth: StyleSheet.hairlineWidth, borderRadius: radius.md, padding: space.sm, marginBottom: space.sm },
  message: { textAlign: 'center', padding: space.xl },
  state: { alignItems: 'center', justifyContent: 'center', padding: space.xl, gap: space.md },
  button: { minHeight: HIT, borderWidth: 1, borderRadius: radius.full, paddingHorizontal: space.xl, alignItems: 'center', justifyContent: 'center', alignSelf: 'flex-start' },
  buttonSmall: { minHeight: 32, paddingHorizontal: space.md },
})
