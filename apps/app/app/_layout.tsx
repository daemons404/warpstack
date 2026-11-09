import { AppProviders, routes } from '@warpstack/app-core'
import { useAccount } from '@warpstack/client/react'
import { BottomInset, CrashScreen, NoServerScreen, TabBar, useColors } from '@warpstack/ui'
import { Link, Stack, useRouter, type ErrorBoundaryProps } from 'expo-router'
import Constants from 'expo-constants'
import { StatusBar } from 'expo-status-bar'
import { Platform, Pressable, Text, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'

// The API is served by the same Worker as the web export, so the web uses its own origin.
// A phone build is pointed at a deployment with EXPO_PUBLIC_API_URL; only a development
// build falls back to a local Worker, so a release build never quietly talks to localhost.
const apiUrl = Platform.OS === 'web' && typeof window !== 'undefined'
  ? window.location.origin
  : process.env.EXPO_PUBLIC_API_URL ?? (__DEV__ ? 'http://localhost:8787' : null)

const web = Platform.OS === 'web'

/** The app's name, from app.json, so a renamed app changes it in one place. */
const appName = Constants.expoConfig?.name ?? 'Warpstack'

// The web build is a preview anyone can open, so it carries the warning; the phone has the
// vault's own native screen for the phrase.
const Banner = () => {
  const c = useColors()
  return (
    <View style={{ backgroundColor: c.bg, borderTopColor: c.border, borderTopWidth: 1, paddingHorizontal: 16, paddingVertical: 8 }}>
      <Text style={{ color: c.muted, fontSize: 13 }}>Preview: no search or image uploads yet, and images open as links. Never paste your recovery phrase here.</Text>
    </View>
  )
}

/** The web's header links. The phone uses the bottom tab bar instead. */
const Nav = () => {
  const c = useColors()
  const account = useAccount()
  const link = { color: c.muted, fontSize: 14, paddingVertical: 8 }
  return (
    <View style={{ flexDirection: 'row', gap: 16, alignItems: 'center', paddingRight: 8 }}>
      <Link href="/" style={link}>Home</Link>
      {account.kind === 'signedIn' ? (
        <>
          <Link href={routes.notifications()} style={link}>Notifications</Link>
          <Link href={routes.settings()} style={link}>Settings</Link>
          <Link href={routes.compose()} style={{ ...link, color: c.accent, fontWeight: '600' }}>Post</Link>
        </>
      ) : account.kind === 'signedOut' || account.kind === 'linking' || account.kind === 'unsupported' ? (
        <Link href={routes.signIn()} style={{ ...link, color: c.accent, fontWeight: '600' }}>Sign in</Link>
      ) : null}
    </View>
  )
}

const Cancel = () => {
  const c = useColors()
  const router = useRouter()
  return (
    <Pressable accessibilityRole="button" onPress={() => router.back()} hitSlop={12}>
      <Text style={{ color: c.text, fontSize: 17 }}>Cancel</Text>
    </Pressable>
  )
}

const Shell = () => {
  const c = useColors()
  const insets = useSafeAreaInsets()
  return (
    <BottomInset.Provider value={web ? 0 : insets.bottom}>
      <View style={{ flex: 1, backgroundColor: c.bg }}>
        <StatusBar style="auto" />
        <View style={{ flex: 1, width: '100%', maxWidth: 640, alignSelf: 'center', backgroundColor: c.surface }}>
          <Stack
            screenOptions={{
              headerStyle: { backgroundColor: c.surface },
              headerTintColor: c.text,
              headerTitleStyle: { fontWeight: '600' },
              headerShadowVisible: false,
              headerBackButtonDisplayMode: 'minimal',
              contentStyle: { backgroundColor: c.surface },
              ...(web ? { headerRight: () => <Nav /> } : {}),
            }}>
            <Stack.Screen name="index" options={{ title: appName }} />
            <Stack.Screen name="channel/[key]" options={{ title: 'Channel' }} />
            <Stack.Screen name="cast/[fid]/[hash]" options={{ title: 'Thread' }} />
            <Stack.Screen name="profile/[fid]" options={{ title: 'Profile' }} />
            <Stack.Screen name="[username]" options={{ title: 'Profile' }} />
            <Stack.Screen name="sign-in" options={{ title: 'Sign in' }} />
            <Stack.Screen name="compose" options={web ? { title: 'Post' } : { title: '', presentation: 'modal', headerLeft: () => <Cancel /> }} />
            <Stack.Screen name="notifications" options={{ title: 'Notifications' }} />
            <Stack.Screen name="settings" options={{ title: 'Settings' }} />
          </Stack>
          {web ? <Banner /> : <TabBar />}
        </View>
      </View>
    </BottomInset.Provider>
  )
}

/** A render error anywhere in the app, shown instead of a blank screen. */
export function ErrorBoundary({ error, retry }: ErrorBoundaryProps) {
  return <CrashScreen error={error} retry={retry} />
}

export default function RootLayout() {
  if (!apiUrl) return <NoServerScreen />
  return (
    <AppProviders config={{ apiUrl, appName }}>
      <Shell />
    </AppProviders>
  )
}
