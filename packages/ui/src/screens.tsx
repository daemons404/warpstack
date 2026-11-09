import { routes } from '@warpstack/app-core'
import { useAccount, useChannel, useChannels, useFeedScreen, useFollowedChannels, useProfileScreen, useThreadScreen, type ListState } from '@warpstack/client/react'
import type { Cast, Channel, User } from '@warpstack/contract'
import { Link, useRouter } from 'expo-router'
import { useEffect, useState, type ReactElement } from 'react'
import { FlatList, Image, Pressable, RefreshControl, StyleSheet, Text, View } from 'react-native'
import { FollowButton, FollowingScreen } from './account-screens.tsx'
import { useRefresh } from './hooks.ts'
import { HomeScope, useHomeTap } from './home-tap.ts'
import { Avatar, Button, CastCard, ErrorState, ListFooter, Loading, Message, nameOf, useStoredImage } from './slots.tsx'
import { HIT, HUES, space, type, useColors } from './theme.ts'

// The M1 screens: channels, a channel's feed, a thread, a profile; with M1.5's sign-in, home
// is the following feed and profiles get a follow button. Search arrives in M2.

/** A list of casts with pull-to-refresh and paging that never loops on a failed page. */
export const CastList = ({ list, header, empty, horizonText, threadRoot }: { list: ListState<Cast>; header?: ReactElement; empty?: string; horizonText: string; threadRoot?: string }) => {
  const c = useColors()
  const r = useRefresh(list.refresh)
  return (
    <FlatList
      data={list.items}
      keyExtractor={item => item.hash}
      renderItem={({ item }) => <CastCard cast={item} threadRoot={threadRoot} />}
      ListHeaderComponent={header}
      ListEmptyComponent={list.status === 'loading' ? <Loading />
        : list.status === 'error' ? <ErrorState error={list.error} retry={list.refresh} />
        : <Message>{empty ?? 'Nothing here yet in the days the index covers.'}</Message>}
      ListFooterComponent={<ListFooter list={list} horizonText={horizonText} />}
      // Automatic loading stops after a failed page; the footer offers a retry instead.
      onEndReached={() => { if (!list.moreError) list.loadMore() }}
      onEndReachedThreshold={1.5}
      refreshControl={<RefreshControl refreshing={r.refreshing} onRefresh={r.onRefresh} tintColor={c.muted} />}
      keyboardDismissMode="on-drag"
      keyboardShouldPersistTaps="handled"
      style={{ backgroundColor: c.surface }}
    />
  )
}

/** A row of tabs under a header: Following and Channels, Casts and Replies. */
export const Tabs = <T extends string>({ tabs, value, onChange }: { tabs: readonly { key: T; label: string }[]; value: T; onChange: (t: T) => void }) => {
  const c = useColors()
  return (
    <View style={[styles.tabs, { borderBottomColor: c.border, backgroundColor: c.surface }]} accessibilityRole="tablist">
      {tabs.map(t => {
        const on = t.key === value
        return (
          <Pressable key={t.key} accessibilityRole="tab" accessibilityState={{ selected: on }} onPress={() => onChange(t.key)}
            style={({ pressed }) => [styles.tab, pressed && { backgroundColor: c.pressed }]}>
            <Text style={[type.body, { fontSize: 15, color: on ? c.text : c.muted, fontWeight: on ? '600' : '500' }]}>{t.label}</Text>
            <View style={[styles.tabMark, { backgroundColor: on ? c.accent : 'transparent' }]} />
          </Pressable>
        )
      })}
    </View>
  )
}

/** A channel's image, stored by the server like an avatar; its first letter until then. */
const ChannelBadge = ({ channelKey, name, image, size }: { channelKey: string; name?: string | undefined; image?: string | undefined; size: number }) => {
  const stored = useStoredImage(image)
  const box = { width: size, height: size, borderRadius: size * 0.25, backgroundColor: HUES[channelKey.length % HUES.length] }
  if (stored) {
    return <Image key={stored.tries} source={{ uri: stored.uri }} onError={stored.onError} accessibilityElementsHidden importantForAccessibility="no" style={box} />
  }
  return (
    <View style={[box, { alignItems: 'center', justifyContent: 'center' }]}>
      <Text allowFontScaling={false} style={{ color: '#fff', fontWeight: '700', fontSize: size * 0.42 }}>{([...(name || channelKey)][0] ?? '#').toUpperCase()}</Text>
    </View>
  )
}

const BADGE = 40

/**
 * A channel in a list: its name, then /key and a line of description. The Link wraps a Pressable
 * that styles an inner View, since Link's asChild can't merge a style function.
 */
const ChannelRow = ({ channel }: { channel: Pick<Channel, 'key' | 'name'> & { description?: string | undefined; image?: string | undefined } }) => {
  const c = useColors()
  const named = !!channel.name && channel.name.toLowerCase() !== channel.key.toLowerCase()
  return (
    <Link href={routes.channel(channel.key)} asChild>
      <Pressable accessibilityRole="link" accessibilityLabel={`/${channel.key}`}>
        {({ pressed }) => (
          <View style={[styles.row, pressed && { backgroundColor: c.pressed }]}>
            <ChannelBadge channelKey={channel.key} name={channel.name} image={channel.image} size={BADGE} />
            <View style={[styles.rowText, { borderBottomColor: c.border }]}>
              <Text style={[type.name, { color: c.text }]} numberOfLines={1}>{named ? channel.name : `/${channel.key}`}</Text>
              <Text style={[type.small, { color: c.muted }]} numberOfLines={1}>
                {named ? `/${channel.key}` : ''}{named && channel.description ? ' · ' : ''}{channel.description ?? ''}
              </Text>
            </View>
          </View>
        )}
      </Pressable>
    </Link>
  )
}

const SectionLabel = ({ children }: { children: string }) => {
  const c = useColors()
  return <Text style={[type.title, styles.section, { color: c.text }]} accessibilityRole="header">{children}</Text>
}

/** Home: the following feed for a signed-in account, with channels a tab away; channels otherwise. */
export const HomeScreen = () => {
  const account = useAccount()
  const [tab, setTab] = useState<'following' | 'channels'>('following')
  if (account.kind !== 'signedIn') return <HomeScope.Provider value><ChannelsScreen /></HomeScope.Provider>
  return (
    <HomeScope.Provider value>
      <View style={{ flex: 1 }}>
        <Tabs tabs={[{ key: 'following', label: 'Following' }, { key: 'channels', label: 'Channels' }] as const} value={tab} onChange={setTab} />
        {tab === 'following' ? <FollowingScreen fid={account.fid} /> : <ChannelsScreen />}
      </View>
    </HomeScope.Provider>
  )
}

/**
 * The channels you follow, kept on this device: imported from Farcaster the first time, then
 * changed only here, since channel follows aren't on protocol yet.
 */
const YourChannels = () => {
  const followed = useFollowedChannels()
  const st = followed.state
  if (st.kind === 'idle') return null
  return (
    <View>
      <SectionLabel>Your channels</SectionLabel>
      {st.kind === 'loading' && <Message>Importing the channels you follow on Farcaster…</Message>}
      {st.kind === 'ready' && st.channels.map(ch => <ChannelRow key={ch.key} channel={{ key: ch.key as Channel['key'], name: ch.name, image: ch.image }} />)}
      {st.kind === 'ready' && st.error && <Message tone="danger">{st.error}</Message>}
      {st.kind === 'ready' && !st.error && st.channels.length === 0 && <Message>Follow a channel from its page to see it here.</Message>}
    </View>
  )
}

const ChannelsScreen = () => {
  const c = useColors()
  const channels = useChannels()
  const followed = useFollowedChannels()
  const signedIn = useAccount().kind === 'signedIn'
  // Pulling to refresh also picks up channels followed on Farcaster since the import.
  const refresh = () => {
    if (signedIn) void followed.reimport()
    return channels.refresh()
  }
  const r = useRefresh(refresh)
  const home = useHomeTap<Channel>(r.onRefresh)
  return (
    <FlatList
      {...home}
      data={channels.items}
      keyExtractor={ch => ch.key}
      renderItem={({ item }) => <ChannelRow channel={item} />}
      ListHeaderComponent={<View>{signedIn && <YourChannels />}<SectionLabel>Popular channels</SectionLabel></View>}
      ListEmptyComponent={channels.status === 'loading' ? <Loading />
        : channels.status === 'error' ? <ErrorState error={channels.error} retry={channels.refresh} /> : <Message>No channels yet.</Message>}
      ListFooterComponent={<ListFooter list={channels as ListState<unknown>} horizonText="" />}
      onEndReached={() => { if (!channels.moreError) channels.loadMore() }}
      onEndReachedThreshold={1.5}
      refreshControl={<RefreshControl refreshing={r.refreshing} onRefresh={r.onRefresh} tintColor={c.muted} />}
      style={{ backgroundColor: c.surface }}
    />
  )
}

export const ChannelScreen = ({ channelKey }: { channelKey: string }) => {
  const c = useColors()
  const router = useRouter()
  const channel = useChannel(channelKey)
  const feed = useFeedScreen({ kind: 'channel', key: channelKey })
  const signedIn = useAccount().kind === 'signedIn'
  const followed = useFollowedChannels()
  const following = followed.isFollowing(channelKey)
  const header = (
    <View style={[styles.head, { borderBottomColor: c.border }]}>
      <View style={styles.headTop}>
        <ChannelBadge channelKey={channelKey} name={channel.data?.name} image={channel.data?.image} size={64} />
        {signedIn && channel.data && (
          <View style={{ flexDirection: 'row', gap: space.sm }}>
            <Button label={following ? 'Following' : 'Follow'} small onPress={() => void (following
              ? followed.unfollow(channelKey)
              : followed.follow({ key: channelKey, name: channel.data!.name, url: channel.data!.url, image: channel.data!.image }))} />
            <Button label="Post here" tone="primary" small onPress={() => router.push(routes.compose({ channel: channelKey }))} />
          </View>
        )}
      </View>
      <Text style={[type.heading, { color: c.text }]} accessibilityRole="header">/{channelKey}</Text>
      {channel.data?.description && <Text style={[type.body, { color: c.text }]}>{channel.data.description}</Text>}
      {channel.data?.followers !== undefined && (
        <Text style={[type.small, { color: c.muted }]}><Text style={{ color: c.text, fontWeight: '600' }}>{channel.data.followers.toLocaleString()}</Text> followers</Text>
      )}
    </View>
  )
  return <CastList list={feed} header={header} horizonText="Older casts in this channel are past the index's window." />
}

export const ThreadScreen = ({ fid, hash }: { fid: number; hash: string }) => {
  const t = useThreadScreen({ fid, hash })
  if (t.status === 'loading' || t.status === 'idle') return <Loading />
  if (!t.data) return <ErrorState error={t.error} retry={t.retry} />
  const { root, ancestors } = t.data
  const header = (
    <View>
      {ancestors.map(a => <CastCard key={a.hash} cast={a} emphasis="ancestor" />)}
      {root.state === 'live'
        ? <CastCard cast={root.cast} emphasis="root" />
        : <Message>{root.state === 'deleted' ? 'This cast was deleted.' : 'This cast was removed by this deployment.'}</Message>}
      <SectionLabel>Replies</SectionLabel>
    </View>
  )
  return <CastList list={t.replies} header={header} empty="No replies yet." horizonText="" threadRoot={hash} />
}

const Stat = ({ n, label, exact }: { n: number | undefined; label: string; exact: boolean }) => {
  const c = useColors()
  if (n === undefined) return null
  return <Text style={[type.small, { color: c.muted }]}><Text style={{ color: c.text, fontWeight: '600' }}>{n.toLocaleString()}{exact ? '' : '+'}</Text> {label}</Text>
}

const ProfileHeader = ({ user, replies, setReplies }: { user: User; replies: boolean; setReplies: (r: boolean) => void }) => {
  const c = useColors()
  return (
    <View>
      <View style={[styles.head, { borderBottomWidth: 0 }]}>
        <View style={styles.headTop}>
          <Avatar user={user} size={72} />
          <FollowButton fid={user.fid} />
        </View>
        <View style={{ gap: space.xxs }}>
          <Text style={[type.heading, { color: c.text }]} accessibilityRole="header">{nameOf(user)}</Text>
          <Text style={[type.small, { color: c.muted }]}>
            {user.username ? `@${user.username} · ` : ''}fid {user.fid}
            {user.pro && <Text style={{ color: c.accent, fontWeight: '600' }}> · Pro</Text>}
          </Text>
        </View>
        {user.bio && <Text style={[type.body, { color: c.text }]}>{user.bio}</Text>}
        <View style={styles.meta}>
          <Stat n={user.following} label="following" exact={user.countsExact} />
          <Stat n={user.followers} label="followers" exact={user.countsExact} />
          {user.location && <Text style={[type.small, { color: c.muted }]}>{user.location}</Text>}
        </View>
      </View>
      <Tabs tabs={[{ key: 'casts', label: 'Casts' }, { key: 'replies', label: 'Casts and replies' }] as const}
        value={replies ? 'replies' : 'casts'} onChange={t => setReplies(t === 'replies')} />
    </View>
  )
}

export const ProfileScreen = ({ who }: { who: { fid: number } | { username: string } }) => {
  const key = 'fid' in who ? `fid:${who.fid}` : `name:${who.username}`
  const [replies, setReplies] = useState(false)
  // A new profile starts on its casts, not on whichever tab the last one was left on.
  useEffect(() => setReplies(false), [key])
  const p = useProfileScreen(who, { replies })
  const router = useRouter()
  // A username is an alias: once it resolves, the URL becomes the canonical FID one.
  useEffect(() => {
    if ('username' in who && p.data) router.replace(routes.profile(p.data.fid))
  }, ['username' in who, p.data?.fid])
  if (p.status === 'loading' || p.status === 'idle') return <Loading />
  if (!p.data) return <ErrorState error={p.error} retry={p.retry} />
  return <CastList list={p.feed} header={<ProfileHeader user={p.data} replies={replies} setReplies={setReplies} />} empty="No casts in the days the index covers." horizonText="" />
}

export const NotFoundScreen = () => {
  const c = useColors()
  return (
    <View style={{ padding: space.xl, alignItems: 'center', gap: space.md }}>
      <Text style={[type.body, { color: c.muted }]}>This page doesn't exist.</Text>
      <Link href={routes.home()} style={{ color: c.accent }}>Go home</Link>
    </View>
  )
}

const styles = StyleSheet.create({
  // A list row: 12 at the sides, the divider starting where the text does.
  row: { flexDirection: 'row', alignItems: 'center', gap: space.md, paddingLeft: space.md, minHeight: 64 },
  rowText: { flex: 1, minWidth: 0, alignSelf: 'stretch', justifyContent: 'center', paddingVertical: space.sm, paddingRight: space.md, borderBottomWidth: StyleSheet.hairlineWidth },
  head: { gap: space.sm, paddingHorizontal: space.md, paddingTop: space.lg, paddingBottom: space.lg, borderBottomWidth: StyleSheet.hairlineWidth },
  headTop: { flexDirection: 'row', alignItems: 'flex-end', justifyContent: 'space-between', marginBottom: space.xs },
  meta: { flexDirection: 'row', flexWrap: 'wrap', columnGap: space.lg, rowGap: space.xs },
  section: { paddingHorizontal: space.md, paddingTop: space.lg, paddingBottom: space.xs },
  tabs: { flexDirection: 'row', borderBottomWidth: StyleSheet.hairlineWidth },
  tab: { flex: 1, alignItems: 'center', justifyContent: 'center', minHeight: HIT + 4, paddingTop: space.sm },
  tabMark: { height: 3, width: 32, borderRadius: 2, marginTop: space.sm },
})
