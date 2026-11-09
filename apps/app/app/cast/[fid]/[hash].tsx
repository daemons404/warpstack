import { params } from '@warpstack/app-core'
import { NotFoundScreen, ThreadScreen } from '@warpstack/ui'
import { useLocalSearchParams } from 'expo-router'

export default function Thread() {
  const p = useLocalSearchParams<{ fid: string; hash: string }>()
  const fid = params.fid(p.fid)
  const hash = params.hash(p.hash)
  if (!fid || !hash) return <NotFoundScreen />
  return <ThreadScreen fid={fid} hash={hash} />
}
