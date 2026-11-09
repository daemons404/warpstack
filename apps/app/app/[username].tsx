import { params } from '@warpstack/app-core'
import { NotFoundScreen, ProfileScreen } from '@warpstack/ui'
import { useLocalSearchParams } from 'expo-router'

/** `/{username}` is an alias: it resolves the name, then the URL becomes `/profile/{fid}`. */
export default function UsernameAlias() {
  const username = params.username(useLocalSearchParams<{ username: string }>().username)
  if (!username) return <NotFoundScreen />
  return <ProfileScreen who={{ username }} />
}
