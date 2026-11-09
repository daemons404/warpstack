import { params } from '@warpstack/app-core'
import { ComposeScreen } from '@warpstack/ui'
import { useLocalSearchParams } from 'expo-router'

/** `/compose?reply=fid:hash`, `?quote=fid:hash` or `?channel=key`; anything malformed is ignored. */
export default function Compose() {
  const q = useLocalSearchParams<{ reply?: string; quote?: string; channel?: string }>()
  return <ComposeScreen reply={params.castRef(q.reply)} quote={params.castRef(q.quote)} channel={params.channel(q.channel)} />
}
