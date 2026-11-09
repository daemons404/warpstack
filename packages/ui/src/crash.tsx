import type { ReactNode } from 'react'
import { ScrollView, Text, View } from 'react-native'
import { Button } from './slots.tsx'
import { space, type, useColors } from './theme.ts'

// Screens for when the app itself can't run: a render error the app shell's error boundary
// caught, or a build that was never told which server it belongs to. Neither needs a provider.

const Frame = ({ title, children }: { title: string; children: ReactNode }) => {
  const c = useColors()
  return (
    <ScrollView style={{ flex: 1, backgroundColor: c.bg }} contentContainerStyle={{ flexGrow: 1, justifyContent: 'center', padding: space.xl, gap: space.md }}>
      <Text accessibilityRole="header" style={[type.heading, { color: c.text }]}>{title}</Text>
      {children}
    </ScrollView>
  )
}

/** A render error: what happened, and a way to try again. */
export const CrashScreen = ({ error, retry }: { error: Error; retry: () => unknown }) => {
  const c = useColors()
  return (
    <Frame title="Something went wrong">
      <Text style={[type.body, { color: c.muted }]}>This screen hit an error. Your account and posts are fine.</Text>
      <Text selectable style={[type.small, { color: c.muted }]} numberOfLines={6}>{error.message}</Text>
      <View style={{ alignItems: 'flex-start' }}>
        <Button label="Try again" tone="primary" onPress={() => void retry()} />
      </View>
    </Frame>
  )
}

/** A phone build made without its server's address. */
export const NoServerScreen = () => {
  const c = useColors()
  return (
    <Frame title="No server set">
      <Text style={[type.body, { color: c.muted }]}>
        This build doesn't know which Warpstack server to use. Build it again with EXPO_PUBLIC_API_URL set to your
        server's address; the deploy prints the exact command.
      </Text>
    </Frame>
  )
}
