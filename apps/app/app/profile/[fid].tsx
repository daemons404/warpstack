import { params } from '@warpstack/app-core'
import { NotFoundScreen, ProfileScreen } from '@warpstack/ui'
import { useLocalSearchParams } from 'expo-router'

export default function Profile() {
  const fid = params.fid(useLocalSearchParams<{ fid: string }>().fid)
  if (!fid) return <NotFoundScreen />
  return <ProfileScreen who={{ fid }} />
}
