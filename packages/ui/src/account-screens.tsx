import { pickPhoto, routes } from '@warpstack/app-core'
import type { Draft, Revocation, WarpError } from '@warpstack/client'
import {
  useAccount, useAccountKeys, useCast, useChannel, useComposer, useFollow, useHomeFeed, useLookupFid, useMarkNotificationsSeen, useMediaOrigin, useNotifications, useUploadPhoto,
  useProfileEditor, useUser, type ListState,
} from '@warpstack/client/react'
import type { AppKey, Cast, Notification } from '@warpstack/contract'
import { keyFingerprint, fromHex, looksLikePhrase, MESSAGE_LIMITS, SCOPE_NAMES } from '@warpstack/protocol'
import { Link, useFocusEffect, useRouter } from 'expo-router'
import { useCallback, useEffect, useRef, useState, type ComponentRef, type ReactNode, type RefObject } from 'react'
import {
  ActivityIndicator, FlatList, Image, Platform, Pressable, RefreshControl, ScrollView, StyleSheet, Text, TextInput, View,
  type KeyboardTypeOptions, type ReturnKeyTypeOptions, type TextInputProps,
} from 'react-native'
import { useKeyboardHeight, useRefresh } from './hooks.ts'
import { useHomeTap } from './home-tap.ts'
import { HeartIcon, PersonIcon, PhotoIcon, QuoteIcon, RecastIcon, ReplyIcon } from './icons.tsx'
import { Avatar, Button, CastCard, ErrorState, ListFooter, Loading, Message, nameOf } from './slots.tsx'
import { AVATAR, HIT, radius, space, type, useBottomInset, useColors } from './theme.ts'

// Account screens: sign-in through the phone's vault, the home feed, the composer,
// notifications and settings (profile, keys, sign-out). The recovery phrase never enters any
// of them: it's typed only into the vault's native sheet, which these screens open.

type Input = ComponentRef<typeof TextInput>

const Section = ({ title, children }: { title: string; children: ReactNode }) => {
  const c = useColors()
  return (
    <View style={{ gap: space.md, paddingHorizontal: space.md, paddingTop: space.lg, paddingBottom: space.xl, borderBottomColor: c.border, borderBottomWidth: StyleSheet.hairlineWidth }}>
      <Text style={[type.label, { color: c.muted }]}>{title.toUpperCase()}</Text>
      {children}
    </View>
  )
}

const Body = ({ children, tone = 'text' }: { children: ReactNode; tone?: 'text' | 'muted' | 'danger' | 'accent' }) => {
  const c = useColors()
  // Warnings are announced as they appear, not only when read.
  const alert = tone === 'danger' ? { accessibilityRole: 'alert' as const, accessibilityLiveRegion: 'assertive' as const } : {}
  return <Text style={[type.body, tone === 'muted' && { fontSize: 15, lineHeight: 21 }, { color: c[tone] }]} {...alert}>{children}</Text>
}

/**
 * A text field. `prose` is for writing people read (casts, bios): it capitalizes sentences and
 * autocorrects. Everything else (usernames, URLs) is typed exactly. The recovery phrase never
 * reaches any of these fields; it goes only into the vault's native sheet, which turns off
 * keyboard learning itself.
 */
const Field = (p: {
  value: string; onChangeText: (s: string) => void; placeholder?: string; multiline?: boolean; label?: string; autoFocus?: boolean
  maxLength?: number; prose?: boolean; returnKeyType?: ReturnKeyTypeOptions; onSubmitEditing?: () => void; keyboardType?: KeyboardTypeOptions
  textContentType?: TextInputProps['textContentType']; inputRef?: RefObject<Input | null>; blurOnSubmit?: boolean
}) => {
  const c = useColors()
  const [focused, setFocused] = useState(false)
  return (
    <View style={{ gap: space.xs }}>
      {p.label && <Text style={[type.small, { color: c.muted, fontWeight: '600' }]}>{p.label}</Text>}
      <TextInput
        ref={p.inputRef}
        value={p.value} onChangeText={p.onChangeText} placeholder={p.placeholder} placeholderTextColor={c.muted}
        multiline={p.multiline} autoFocus={p.autoFocus} maxLength={p.maxLength}
        autoCapitalize={p.prose ? 'sentences' : 'none'} autoCorrect={!!p.prose} spellCheck={!!p.prose} autoComplete="off"
        keyboardType={p.keyboardType} textContentType={p.textContentType}
        returnKeyType={p.returnKeyType} onSubmitEditing={p.onSubmitEditing}
        submitBehavior={p.multiline ? 'newline' : p.blurOnSubmit === false ? 'submit' : 'blurAndSubmit'}
        onFocus={() => setFocused(true)} onBlur={() => setFocused(false)}
        selectionColor={c.accent}
        style={[type.body, styles.input, { color: c.text, borderColor: focused ? c.accent : c.border, backgroundColor: c.field },
          p.multiline && { minHeight: 96, textAlignVertical: 'top', paddingTop: space.md }]}
      />
    </View>
  )
}

const PHRASE_CLEARED = 'That looks like a recovery phrase. It was cleared and not sent or saved. Never type your phrase into an app\'s text box: it goes only into the vault\'s own secure screen.'

/** The phone's vault: one button that opens its native sheet. */
const DeviceApproval = ({ label, what, onApprove }: { label: string; what: string; onApprove: () => Promise<WarpError | null> }) => {
  const c = useColors()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  return (
    <View style={{ gap: space.md }}>
      <Body>The vault opens a secure screen, separate from the rest of this app, that shows what it will sign: {what}. Type your recovery phrase there. It stays on this phone and is forgotten right after signing.</Body>
      {error && <Body tone="danger">{error}</Body>}
      <Button label={busy ? 'Working…' : label} tone="primary" block disabled={busy} onPress={async () => {
        setBusy(true)
        setError(null)
        const e = await onApprove()
        setBusy(false)
        if (e && e.kind !== 'cancelled') setError(e.message)
      }} />
      <Text style={[type.small, { color: c.muted, textAlign: 'center' }]}>Never type your phrase anywhere else in this app.</Text>
    </View>
  )
}

// The shell's tab bar already sits over the home indicator, so pages pad only for breathing room.
const Page = ({ children }: { children: ReactNode }) => {
  const c = useColors()
  return (
    <ScrollView style={{ backgroundColor: c.surface }} contentContainerStyle={{ paddingBottom: space.xl }}
      keyboardShouldPersistTaps="handled" keyboardDismissMode="interactive" automaticallyAdjustKeyboardInsets>
      {children}
    </ScrollView>
  )
}

export const SignInScreen = () => {
  const router = useRouter()
  const account = useAccount()
  const lookup = useLookupFid()
  const [who, setWho] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (account.kind === 'signedIn') router.replace(routes.home())
  }, [account.kind])

  if (account.kind === 'loading') return <Loading />
  if (account.kind === 'unsupported') {
    return (
      <Page>
        <Section title="Sign in">
          <Body>{Platform.OS === 'web'
            ? 'Sign in with the Warpstack phone app. Linking this browser from the phone comes later; until then the web is read-only.'
            : 'The vault isn\'t available. This build may not include it (build it with pnpm --filter @warpstack/app ios), or the phone is locked or has no passcode.'}</Body>
        </Section>
      </Page>
    )
  }

  if (account.kind === 'linking') {
    return (
      <Page>
        <Section title={`Sign in as FID ${account.fid}`}>
          <DeviceApproval label="Approve with recovery phrase" what={`a key for this phone, ${account.fingerprint}, that can post, react, follow and edit your profile`} onApprove={async () => {
            const r = await account.controller.approveSignIn()
            return r.ok ? null : r.error
          }} />
          <Button label="Start over" block onPress={() => void account.controller.cancelSignIn()} />
        </Section>
      </Page>
    )
  }

  const submit = async () => {
    if (busy || !who.trim()) return
    setBusy(true)
    setError(null)
    const found = await lookup.run(who)
    if (!found.ok) {
      if (found.error.kind === 'phrase') setWho('')
      setError(found.error.kind === 'phrase' ? PHRASE_CLEARED : found.error.message)
    } else {
      const r = await account.controller.startSignIn(found.value)
      if (!r.ok) setError(r.error.message)
      else {
        // Straight to the vault's sheet.
        const a = await account.controller.approveSignIn()
        if (!a.ok && a.error.kind !== 'cancelled') setError(a.error.message)
      }
    }
    setBusy(false)
  }

  return (
    <Page>
      <Section title="Sign in">
        {account.kind === 'signedOut' && account.notice && <Body tone="danger">{account.notice}</Body>}
        <Body>Sign in with your Farcaster account. This phone makes its own key, and your recovery phrase approves it in the vault's secure screen. The rest of the app never sees the phrase.</Body>
        <Field label="Username or FID" value={who} placeholder="alice or 1234" autoFocus maxLength={64}
          textContentType="username" returnKeyType="go" onSubmitEditing={() => void submit()}
          onChangeText={t => {
            if (looksLikePhrase(t)) {
              setWho('')
              setError(PHRASE_CLEARED)
            } else setWho(t)
          }} />
        {error && <Body tone="danger">{error}</Body>}
        <Button label={busy ? 'Looking up…' : 'Continue'} tone="primary" block disabled={busy || !who.trim()} onPress={() => void submit()} />
      </Section>
      <Section title="What the key can do">
        <Body tone="muted">Post and delete casts, like and recast, follow and unfollow, and edit your profile, for 30 days after it was last used. It can't add or remove keys, move your account, change your recovery address or touch funds. Sign out or revoke it at any time in Settings.</Body>
      </Section>
    </Page>
  )
}

/**
 * Shown while this phone's key is within a few days of expiring (it slides forward with each
 * post or like). Renewing makes a fresh key and approves it with the recovery phrase, as at
 * sign-in; until then everything keeps working.
 */
export const RenewKeyBanner = () => {
  const c = useColors()
  const account = useAccount()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  if (account.kind !== 'signedIn' || !account.renewDue) return null
  const days = account.expiresAt ? Math.max(0, Math.ceil((account.expiresAt - Date.now() / 1000) / 86_400)) : 0
  const when = days <= 0 ? 'today' : days === 1 ? 'tomorrow' : `in ${days} days`
  return (
    <View style={[styles.renew, { backgroundColor: c.field, borderColor: c.border }]}>
      <Body>This phone's sign-in key expires {when}. Renew it to keep posting.</Body>
      {error && <Body tone="danger">{error}</Body>}
      <Button label={busy ? 'Renewing…' : 'Renew with recovery phrase'} tone="primary" small disabled={busy} onPress={async () => {
        setBusy(true)
        setError(null)
        const r = await account.controller.renew()
        if (!r.ok && r.error.kind !== 'cancelled') setError(r.error.message)
        setBusy(false)
      }} />
    </View>
  )
}

/** Home: the following feed once signed in. */
export const FollowingScreen = ({ fid }: { fid: number }) => {
  const c = useColors()
  const router = useRouter()
  const feed = useHomeFeed()
  const me = useUser(fid)
  return <Feed list={feed} empty="Nothing from accounts you follow in the days the index covers." header={<>
    <RenewKeyBanner />
    <Pressable accessibilityRole="button" accessibilityLabel="Write a cast" onPress={() => router.push(routes.compose())}
      style={({ pressed }) => [styles.composeBar, { borderBottomColor: c.border }, pressed && { backgroundColor: c.pressed }]}>
      <Avatar user={me.data ?? { fid }} size={36} />
      <View style={[styles.composePill, { backgroundColor: c.field }]}>
        <Text style={[type.body, { color: c.muted }]}>What's happening?</Text>
      </View>
    </Pressable>
  </>} />
}

const Feed = ({ list, empty, header }: { list: ListState<Cast>; empty: string; header?: React.ReactElement }) => {
  const c = useColors()
  const r = useRefresh(list.refresh)
  const home = useHomeTap<Cast>(r.onRefresh)
  return (
    <FlatList
      {...home}
      data={list.items}
      keyExtractor={item => item.hash}
      renderItem={({ item }) => <CastCard cast={item} />}
      ListHeaderComponent={header}
      ListEmptyComponent={list.status === 'loading' ? <Loading /> : list.status === 'error' ? <ErrorState error={list.error} retry={list.refresh} /> : <Message>{empty}</Message>}
      ListFooterComponent={<ListFooter list={list} horizonText="Older casts are past the index's window." />}
      onEndReached={() => { if (!list.moreError) list.loadMore() }}
      onEndReachedThreshold={1.5}
      refreshControl={<RefreshControl refreshing={r.refreshing} onRefresh={r.onRefresh} tintColor={c.muted} />}
      keyboardDismissMode="on-drag"
      style={{ backgroundColor: c.surface }}
    />
  )
}

/**
 * The composer: the draft fills the screen, and a toolbar with the context, the byte counter
 * and Post stays just above the keyboard, so Post is never hidden behind it.
 */
export const ComposeScreen = ({ reply, quote, channel }: { reply?: { fid: number; hash: string } | null; quote?: { fid: number; hash: string } | null; channel?: string | null }) => {
  const c = useColors()
  const router = useRouter()
  const account = useAccount()
  const composer = useComposer()
  const sending = composer.busy
  const [text, setText] = useState('')
  const [error, setError] = useState<string | null>(null)
  // Sent but not yet seen merging: posting again could post it twice.
  const [unconfirmed, setUnconfirmed] = useState(false)
  const channelInfo = useChannel(channel ?? '', { enabled: !!channel })
  const parentCast = useCast(reply ?? null)
  const quoted = useCast(quote ?? null)
  const me = useUser(account.kind === 'signedIn' ? account.fid : null)
  const keyboard = useKeyboardHeight()
  const bottom = useBottomInset()
  const input = useRef<Input>(null)
  // One photo per cast for now. It's uploaded as soon as it's picked, so posting is instant.
  const media = useMediaOrigin()
  const upload = useUploadPhoto()
  const [photo, setPhoto] = useState<{ uri: string; width: number; height: number; state: 'uploading' | 'ready' | 'failed'; url?: string } | null>(null)
  const choosePhoto = async () => {
    setError(null)
    const picked = await pickPhoto().catch(() => null)
    if (!picked) return
    setPhoto({ ...picked, state: 'uploading' })
    const r = await upload.run(picked.uri)
    setPhoto(p => (p?.uri !== picked.uri ? p : r.ok ? { ...p, state: 'ready', url: r.value.url } : { ...p, state: 'failed' }))
    if (!r.ok) setError(r.error.message)
  }

  if (account.kind !== 'signedIn') return <SignInPrompt what="post" />
  const bytes = new TextEncoder().encode(text).length
  const left = MESSAGE_LIMITS.castText - bytes
  const phrase = looksLikePhrase(text)
  const over = left < 0
  const parent: Draft['parent'] = reply ? reply : channelInfo.data ? { url: channelInfo.data.url } : undefined
  const photoReady = photo?.state === 'ready' && !!photo.url
  const blocked = sending || unconfirmed || over || phrase || photo?.state === 'uploading' || photo?.state === 'failed'
    || (!text.trim() && !quote && !photoReady) || (!!channel && !channelInfo.data)
  const context = reply
    ? `Replying to ${parentCast.data ? `@${parentCast.data.author.username ?? `fid:${parentCast.data.fid}`}` : 'a cast'}`
    : quote ? 'Quoting a cast' : channel ? `Posting in /${channel}` : 'Posting to your followers'

  const post = async () => {
    if (blocked) return
    setError(null)
    const r = await composer.run({ text, parent, quote: quote ?? undefined, images: photoReady ? [photo.url!] : undefined })
    if (r.ok) router.back()
    else {
      if (r.error.kind === 'unconfirmed') setUnconfirmed(true)
      setError(r.error.message)
    }
  }

  return (
    <View style={{ flex: 1, backgroundColor: c.surface }}>
      <ScrollView style={{ flex: 1 }} keyboardShouldPersistTaps="handled" keyboardDismissMode="interactive"
        contentContainerStyle={{ paddingBottom: space.xl }}>
        {parentCast.data && <CastCard cast={parentCast.data} emphasis="ancestor" />}
        <Pressable onPress={() => input.current?.focus()} style={styles.draft} accessible={false}>
          <Avatar user={me.data ?? { fid: account.fid }} size={AVATAR} />
          <TextInput
            ref={input} value={text} onChangeText={setText}
            placeholder={reply ? 'Write your reply' : "What's happening?"} placeholderTextColor={c.muted}
            multiline autoFocus scrollEnabled={false} selectionColor={c.accent}
            autoCapitalize="sentences" autoCorrect spellCheck
            accessibilityLabel={reply ? 'Reply text' : 'Cast text'}
            style={[type.body, { flex: 1, color: c.text, fontSize: 17, lineHeight: 24, minHeight: 120, paddingTop: Platform.OS === 'ios' ? 12 : 10, textAlignVertical: 'top' }]}
          />
        </Pressable>
        {photo && (
          <View style={styles.photo}>
            <Image source={{ uri: photo.uri }} accessibilityLabel="The photo you're posting"
              style={{ width: '100%', aspectRatio: photo.width / photo.height, maxHeight: 360, borderRadius: radius.md, backgroundColor: c.field, opacity: photo.state === 'ready' ? 1 : 0.6 }} />
            {photo.state === 'uploading' && <ActivityIndicator style={StyleSheet.absoluteFill} color={c.accent} />}
            <Pressable accessibilityRole="button" accessibilityLabel="Remove photo" hitSlop={8} onPress={() => { setPhoto(null); setError(null) }}
              style={[styles.removePhoto, { backgroundColor: c.surface, borderColor: c.border }]}>
              <Text style={{ color: c.text, fontWeight: '700' }}>✕</Text>
            </Pressable>
          </View>
        )}
        {quoted.data && (
          <View style={[styles.quoted, { borderColor: c.border }]}>
            <CastCard cast={quoted.data} emphasis="ancestor" />
          </View>
        )}
        <View style={{ paddingHorizontal: space.md, gap: space.sm }}>
          {phrase && <Body tone="danger">This looks like a recovery phrase. It won't be posted: anyone who sees it can take the account.</Body>}
          {error && <Body tone="danger">{error}</Body>}
        </View>
      </ScrollView>
      <View style={[styles.toolbar, { borderTopColor: c.border, backgroundColor: c.surface, paddingBottom: (keyboard > 0 ? keyboard : bottom) + space.sm }]}>
        {/* Only when this server stores images, and one per cast. */}
        {media && !photo && Platform.OS !== 'web' && (
          <Pressable accessibilityRole="button" accessibilityLabel="Add a photo" hitSlop={8} onPress={() => void choosePhoto()} disabled={sending}
            style={({ pressed }) => [styles.toolIcon, pressed && { backgroundColor: c.pressed }]}>
            <PhotoIcon color={c.muted} size={20} />
          </Pressable>
        )}
        <Text style={[type.small, { color: c.muted, flex: 1 }]} numberOfLines={1}>{context}</Text>
        {/* The counter appears near the limit, like most clients, instead of always. */}
        {left <= 40 && <Text style={[type.small, { color: over ? c.danger : c.muted, fontWeight: '600' }]} accessibilityLabel={`${left} bytes left`}>{left}</Text>}
        <Button label={sending ? 'Posting…' : unconfirmed ? 'Sent' : reply ? 'Reply' : 'Post'} tone="primary" small disabled={blocked} onPress={() => void post()} />
      </View>
    </View>
  )
}

const SignInPrompt = ({ what }: { what: string }) => {
  const router = useRouter()
  return (
    <View style={{ padding: space.xl, alignItems: 'center', gap: space.md }}>
      <Body tone="muted">Sign in to {what}.</Body>
      <Button label="Sign in" tone="primary" onPress={() => router.push(routes.signIn())} />
    </View>
  )
}

const NOTE_VERB: Record<string, string> = { like: 'liked your cast', recast: 'recast your cast', follow: 'followed you', reply: 'replied', mention: 'mentioned you', quote: 'quoted your cast' }

/** Who did it, as the Farcaster client says it: "Alice", "Alice and Bob", "Alice, Bob and 10 others". */
const whoDid = (n: Notification) => {
  const names = n.actors.slice(0, 2).map(nameOf)
  const others = n.count - names.length
  if (!names.length) return `${n.count} people`
  if (others <= 0) return names.join(' and ')
  return `${names.join(', ')} and ${others.toLocaleString()} ${others === 1 ? 'other' : 'others'}`
}

const NoteIcon = ({ kind }: { kind: string }) => {
  const c = useColors()
  switch (kind) {
    case 'like': return <HeartIcon color="#d51338" size={20} filled />
    case 'recast': return <RecastIcon color="#14ae5c" size={20} />
    case 'follow': return <PersonIcon color={c.accent} size={20} />
    case 'quote': return <QuoteIcon color={c.accent} size={20} />
    default: return <ReplyIcon color={c.accent} size={20} />
  }
}

/**
 * One inbox group. Replies, mentions and quotes are the cast itself, labelled; likes, recasts and
 * follows are a row of faces and a sentence, with the cast they're about beneath.
 */
const NotificationRow = ({ n }: { n: Notification }) => {
  const c = useColors()
  const router = useRouter()
  const unseen = !n.seen && { backgroundColor: c.field }
  if ((n.kind === 'reply' || n.kind === 'mention' || n.kind === 'quote') && n.cast) {
    return (
      <View style={[unseen || undefined]}>
        <View style={styles.noteLabel}>
          <NoteIcon kind={n.kind} />
          <Text style={[type.small, { color: c.muted }]}>{nameOf(n.cast.author)} {NOTE_VERB[n.kind]}</Text>
        </View>
        <CastCard cast={n.cast} />
      </View>
    )
  }
  const open = () => (n.cast ? router.push(routes.thread(n.cast)) : n.actors[0] ? router.push(routes.profile(n.actors[0].fid)) : undefined)
  return (
    <Pressable onPress={open} accessibilityRole="button" accessibilityLabel={`${whoDid(n)} ${NOTE_VERB[n.kind] ?? ''}`}
      style={({ pressed }) => [styles.note, { borderBottomColor: c.border }, unseen, pressed && { backgroundColor: c.pressed }]}>
      <View style={styles.noteIcon}><NoteIcon kind={n.kind} /></View>
      <View style={{ flex: 1, minWidth: 0, gap: space.xs }}>
        <View style={{ flexDirection: 'row', gap: space.xs }}>
          {n.actors.slice(0, 7).map(u => <Avatar key={u.fid} user={u} size={28} />)}
        </View>
        <Text style={[type.body, { color: c.text }]} numberOfLines={2}>
          <Text style={{ fontWeight: '600' }}>{whoDid(n)}</Text> {NOTE_VERB[n.kind] ?? ''}
        </Text>
        {n.cast?.text ? <Text style={[type.body, { color: c.muted }]} numberOfLines={3}>{n.cast.text}</Text> : null}
      </View>
    </Pressable>
  )
}

export const NotificationsScreen = () => {
  const c = useColors()
  const account = useAccount()
  const list = useNotifications()
  const markSeen = useMarkNotificationsSeen().run
  const r = useRefresh(list.refresh)
  // Looking at the inbox marks what's in it as seen; unseen rows stay tinted until the next visit.
  const newest = list.items[0]?.ts
  useFocusEffect(useCallback(() => {
    if (newest !== undefined) void markSeen(newest)
  }, [newest, markSeen]))
  if (account.kind !== 'signedIn') return <SignInPrompt what="see notifications" />
  return (
    <FlatList
      data={list.items}
      keyExtractor={n => n.id}
      renderItem={({ item }) => <NotificationRow n={item} />}
      ListEmptyComponent={list.status === 'loading' ? <Loading /> : list.status === 'error' ? <ErrorState error={list.error} retry={list.refresh} />
        : <Message>Nothing yet. Likes, recasts, replies, mentions, quotes and new followers show up here.</Message>}
      ListFooterComponent={<ListFooter list={list as ListState<unknown>} horizonText="Older notifications are past the 30 days the inbox keeps." />}
      onEndReached={() => { if (!list.moreError) list.loadMore() }}
      onEndReachedThreshold={1.5}
      refreshControl={<RefreshControl refreshing={r.refreshing} onRefresh={r.onRefresh} tintColor={c.muted} />}
      style={{ backgroundColor: c.surface }}
    />
  )
}

/** Follow or unfollow, on a profile that isn't the viewer's own. */
export const FollowButton = ({ fid }: { fid: number }) => {
  const account = useAccount()
  if (account.kind !== 'signedIn' || account.fid === fid) return null
  return <FollowToggle fid={fid} />
}

const FollowToggle = ({ fid }: { fid: number }) => {
  const c = useColors()
  const f = useFollow(fid)
  if (!f.known) return null
  return (
    <View style={{ gap: space.xs, alignItems: 'flex-end' }}>
      <Button label={f.on ? 'Following' : 'Follow'} tone={f.on ? 'default' : 'primary'} small disabled={f.busy} onPress={() => void f.toggle()} />
      {f.error && <Text style={[type.small, { color: c.danger }]}>{f.error.message}</Text>}
    </View>
  )
}

const ProfileEditor = ({ fid }: { fid: number }) => {
  const c = useColors()
  const save = useProfileEditor()
  const user = useUser(fid)
  const [fields, setFields] = useState<{ display: string; bio: string; url: string } | null>(null)
  const [status, setStatus] = useState<{ text: string; tone: 'muted' | 'danger' } | null>(null)
  const [busy, setBusy] = useState(false)
  const bio = useRef<Input>(null)
  const url = useRef<Input>(null)
  useEffect(() => {
    if (user.data && !fields) setFields({ display: user.data.displayName ?? '', bio: user.data.bio ?? '', url: user.data.url ?? '' })
  }, [user.data])
  if (!fields || !user.data) return user.status === 'error' ? <ErrorState error={user.error} retry={user.retry} /> : <Loading />
  const u = user.data
  const phrase = looksLikePhrase(`${fields.display} ${fields.bio} ${fields.url}`)
  const changes = {
    ...(fields.display !== (u.displayName ?? '') ? { display: fields.display } : {}),
    ...(fields.bio !== (u.bio ?? '') ? { bio: fields.bio } : {}),
    ...(fields.url !== (u.url ?? '') ? { url: fields.url } : {}),
  }
  const submit = async () => {
    if (busy || phrase || !Object.keys(changes).length) return
    setBusy(true)
    const r = await save.run(changes)
    setBusy(false)
    setStatus(r.ok ? { text: 'Saved. Other screens catch up within a few minutes.', tone: 'muted' } : { text: r.error.message, tone: 'danger' })
  }
  return (
    <View style={{ gap: space.md }}>
      <Field label="Display name" value={fields.display} onChangeText={display => setFields({ ...fields, display })} maxLength={32}
        prose textContentType="name" returnKeyType="next" blurOnSubmit={false} onSubmitEditing={() => bio.current?.focus()} />
      <Field label="Bio" inputRef={bio} value={fields.bio} onChangeText={b => setFields({ ...fields, bio: b })} multiline prose maxLength={256} />
      <Field label="Website" inputRef={url} value={fields.url} onChangeText={w => setFields({ ...fields, url: w })} placeholder="https://"
        keyboardType="url" textContentType="URL" returnKeyType="done" onSubmitEditing={() => void submit()} />
      {phrase && <Body tone="danger">This looks like a recovery phrase. It won't be saved: your profile is public.</Body>}
      {status && <Body tone={status.tone}>{status.text}</Body>}
      <Button label={busy ? 'Saving…' : 'Save profile'} tone="primary" block disabled={busy || phrase || !Object.keys(changes).length} onPress={() => void submit()} />
      <Text style={[type.small, { color: c.muted }]}>Profile pictures need hosted images, which arrive with M2.</Text>
    </View>
  )
}

const when = (t: number | undefined) => (t ? new Date(t * 1_000).toLocaleDateString() : '—')

const KeyRow = ({ k, mine, onRevoke }: { k: AppKey; mine: boolean; onRevoke: () => void }) => {
  const c = useColors()
  const key = fromHex(k.key, 32)
  return (
    <View style={[styles.keyRow, { borderColor: mine ? c.accent : c.border, backgroundColor: mine ? c.field : c.surface }]}>
      <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: space.sm }}>
        <Text style={[type.name, { color: c.text, flexShrink: 1 }]}>{key ? keyFingerprint(key) : k.key.slice(0, 10)}{mine ? ' · this phone' : ''}</Text>
        {k.source === 'gasless' && !mine && <Button label="Revoke" tone="danger" small onPress={onRevoke} />}
      </View>
      <Text style={[type.small, { color: c.muted }]}>
        {k.source === 'onchain'
          ? `Onchain key from another app, added ${when(k.addedAt)}. It can sign anything except key changes; remove it from the app that made it.`
          : `Can ${k.scopes.map(s => SCOPE_NAMES[s] ?? `type ${s}`).join(', ') || 'nothing'}. Added ${when(k.addedAt)}, expires ${when(k.expiresAt)} unless used.`}
      </Text>
    </View>
  )
}

export const SettingsScreen = () => {
  const c = useColors()
  const account = useAccount()
  const keys = useAccountKeys()
  const [revoking, setRevoking] = useState<Revocation | null>(null)
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState<{ text: string; tone: 'muted' | 'danger' } | null>(null)
  if (account.kind !== 'signedIn') return <SignInPrompt what="manage your account" />
  const myKey = Array.from(account.publicKey, b => b.toString(16).padStart(2, '0')).join('')
  const revoked = () => {
    setRevoking(null)
    setStatus({ text: 'Revoked. It disappears from this list within a few seconds.', tone: 'muted' })
    setTimeout(keys.retry, 3_000)
  }

  return (
    <Page>
      <RenewKeyBanner />
      <Section title="Account">
        <Body>Signed in as <Link href={routes.profile(account.fid)} style={{ color: c.accent, fontWeight: '600' }}>FID {account.fid}</Link> with this phone's key {account.fingerprint}.</Body>
        <Body tone="muted">Your recovery phrase is typed only into the vault's secure screen, used for one signature and not kept. If you lose this phone, sign in on another and revoke its key below; the key can post as you but can't move your account.</Body>
      </Section>
      <Section title="Profile"><ProfileEditor fid={account.fid} /></Section>
      <Section title="Keys">
        {status && <Body tone={status.tone}>{status.text}</Body>}
        {revoking ? (
          <View style={{ gap: space.md }}>
            <Body>Revoke key {revoking.fingerprint}</Body>
            <DeviceApproval label="Revoke with recovery phrase" what={`the removal of key ${revoking.fingerprint}`} onApprove={async () => {
              const r = await account.controller.approveRevoke(revoking)
              if (!r.ok) return r.error
              revoked()
              return null
            }} />
            <Button label="Cancel" block onPress={() => setRevoking(null)} />
          </View>
        ) : keys.status === 'loading' || keys.status === 'idle' ? <Loading /> : keys.status === 'error' ? <ErrorState error={keys.error} retry={keys.retry} /> : (
          <View style={{ gap: space.sm }}>
            {(keys.data?.keys ?? []).map(k => (
              <KeyRow key={k.key} k={k} mine={k.key === `0x${myKey}`} onRevoke={async () => {
                setStatus(null)
                const r = await account.controller.startRevoke(k.key)
                if (r.ok) setRevoking(r.value)
                else setStatus({ text: r.error.message, tone: 'danger' })
              }} />
            ))}
            <Text style={[type.small, { color: c.muted }]} selectable>Custody address {keys.data?.custody}. Only your recovery phrase controls it.</Text>
          </View>
        )}
      </Section>
      <Section title="Sign out">
        <Body tone="muted">Signing out revokes this phone's key and forgets it.</Body>
        <Button label={busy ? 'Signing out…' : 'Sign out'} tone="danger" block disabled={busy} onPress={async () => {
          setBusy(true)
          const r = await account.controller.signOut()
          setBusy(false)
          if (!r.ok) setStatus({ text: r.error.message, tone: 'danger' })
        }} />
      </Section>
    </Page>
  )
}

const styles = StyleSheet.create({
  note: { flexDirection: 'row', gap: space.md, paddingHorizontal: space.md, paddingVertical: space.md, borderBottomWidth: StyleSheet.hairlineWidth },
  noteIcon: { width: 28, alignItems: 'flex-end', paddingTop: 4 },
  noteLabel: { flexDirection: 'row', alignItems: 'center', gap: space.sm, paddingHorizontal: space.md, paddingTop: space.md, marginBottom: -space.xs },
  // The photo sits under the text, past the avatar, like an embed in a cast.
  photo: { paddingLeft: space.md + AVATAR + space.md, paddingRight: space.md, paddingTop: space.sm },
  removePhoto: { position: 'absolute', top: space.sm + 8, right: space.md + 8, width: 32, height: 32, borderRadius: 16, alignItems: 'center', justifyContent: 'center', borderWidth: StyleSheet.hairlineWidth },
  input: { minHeight: HIT, borderWidth: 1, borderRadius: radius.md, paddingHorizontal: space.md, paddingVertical: space.sm },
  composeBar: { flexDirection: 'row', alignItems: 'center', gap: space.md, paddingHorizontal: space.md, paddingVertical: space.md, borderBottomWidth: StyleSheet.hairlineWidth },
  composePill: { flex: 1, minHeight: 40, borderRadius: radius.full, paddingHorizontal: space.md, justifyContent: 'center' },
  renew: { margin: space.lg, marginBottom: 0, padding: space.lg, gap: space.md, borderRadius: radius.lg, borderWidth: StyleSheet.hairlineWidth },
  // The composer lines up with a cast: 12 at the sides, the feed's avatar, 12 between.
  draft: { flexDirection: 'row', alignItems: 'flex-start', gap: space.md, paddingHorizontal: space.md, paddingTop: space.md },
  quoted: { marginLeft: space.md + AVATAR + space.md, marginRight: space.md, marginTop: space.sm, borderWidth: StyleSheet.hairlineWidth, borderRadius: radius.md, overflow: 'hidden' },
  toolIcon: { width: 36, height: 36, borderRadius: radius.full, alignItems: 'center', justifyContent: 'center' },
  toolbar: { flexDirection: 'row', alignItems: 'center', gap: space.md, paddingHorizontal: space.md, paddingTop: space.sm, borderTopWidth: StyleSheet.hairlineWidth },
  kind: { paddingHorizontal: space.md, paddingTop: space.md, marginLeft: 40 + space.md },
  row: { flexDirection: 'row', alignItems: 'center', gap: space.md, paddingHorizontal: space.md, paddingVertical: space.md, borderBottomWidth: StyleSheet.hairlineWidth, minHeight: 64 },
  keyRow: { borderWidth: 1, borderRadius: radius.md, padding: space.md, gap: space.xs },
})
