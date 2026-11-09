import { routes } from '@warpstack/app-core'
import { useAccount, useUnseenNotifications } from '@warpstack/client/react'
import { usePathname, useRouter } from 'expo-router'
import type { ComponentType } from 'react'
import { Pressable, StyleSheet, Text, View } from 'react-native'
import { tapHome } from './home-tap.ts'
import { BellTabIcon, HomeTabIcon, SettingsTabIcon } from './icons.tsx'
import { HIT, radius, space, useBottomInset, useColors } from './theme.ts'

type TabIcon = ComponentType<{ color: string; background: string; selected: boolean }>
type Item = { label: string; Icon?: TabIcon; href: string; match: (path: string) => boolean; primary?: boolean; badge?: boolean }

/**
 * The phone's bottom navigation: home, posting, notifications and settings once signed in;
 * home and sign-in otherwise. Icons only and no top rule, as in the Farcaster client: outlined
 * tabs, the selected one filled, all in the text color; posting keeps its accent button. It
 * sits above the home indicator; the web keeps its header links.
 */
export const TabBar = () => {
  const c = useColors()
  const router = useRouter()
  const path = usePathname()
  const account = useAccount()
  const bottom = useBottomInset()
  const unseen = useUnseenNotifications()
  if (account.kind === 'loading') return null
  const items: Item[] = account.kind === 'signedIn'
    ? [
      { label: 'Home', Icon: HomeTabIcon, href: routes.home(), match: p => p === '/' },
      { label: 'Post', href: routes.compose(), match: () => false, primary: true },
      { label: 'Notifications', Icon: BellTabIcon, href: routes.notifications(), match: p => p.startsWith('/notifications'), badge: (unseen.data ?? 0) > 0 },
      { label: 'Settings', Icon: SettingsTabIcon, href: routes.settings(), match: p => p.startsWith('/settings') },
    ]
    : [
      { label: 'Home', Icon: HomeTabIcon, href: routes.home(), match: p => p === '/' },
      { label: 'Sign in', Icon: SettingsTabIcon, href: routes.signIn(), match: p => p.startsWith('/sign-in') },
    ]
  return (
    <View style={[styles.bar, { backgroundColor: c.surface, paddingBottom: Math.max(bottom, space.sm) }]} accessibilityRole="tablist">
      {items.map(item => {
        const on = item.match(path)
        return (
          <Pressable key={item.label} accessibilityRole={item.primary ? 'button' : 'tab'} accessibilityLabel={item.primary ? 'Write a cast' : item.label}
            accessibilityState={{ selected: on }}
            // Compose opens over whatever is showing; the tabs replace it. Home again scrolls
            // the feed to the top, or refreshes it there.
            onPress={() => (item.primary ? router.push(item.href) : on ? (item.label === 'Home' ? tapHome() : undefined) : router.navigate(item.href))}
            style={({ pressed }) => [styles.item, pressed && { opacity: 0.6 }]}>
            {item.primary ? (
              <View style={[styles.post, { backgroundColor: c.accentFill }]}>
                <Text allowFontScaling={false} style={{ color: c.accentText, fontSize: 24, lineHeight: 26, fontWeight: '500' }}>+</Text>
              </View>
            ) : item.Icon ? (
              <View>
                <item.Icon color={c.text} background={c.surface} selected={on} />
                {/* Something new in the inbox: a dot, as in the Farcaster client. */}
                {item.badge && !on && <View accessibilityLabel="New notifications" style={[styles.dot, { backgroundColor: c.accent, borderColor: c.surface }]} />}
              </View>
            ) : null}
          </Pressable>
        )
      })}
    </View>
  )
}

const styles = StyleSheet.create({
  bar: { flexDirection: 'row', paddingTop: space.xs },
  item: { flex: 1, alignItems: 'center', justifyContent: 'center', minHeight: HIT + 4 },
  dot: { position: 'absolute', top: 8, right: 8, width: 10, height: 10, borderRadius: 5, borderWidth: 2 },
  post: { width: 44, height: 36, borderRadius: radius.full, alignItems: 'center', justifyContent: 'center' },
})
