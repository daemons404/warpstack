import { params } from '@warpstack/app-core'
import { ChannelScreen, NotFoundScreen } from '@warpstack/ui'
import { Stack, useLocalSearchParams } from 'expo-router'

export default function Channel() {
  const key = params.channel(useLocalSearchParams<{ key: string }>().key)
  if (!key) return <NotFoundScreen />
  return <><Stack.Screen options={{ title: `/${key}` }} /><ChannelScreen channelKey={key} /></>
}
