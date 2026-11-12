import type { EmbedMetadata } from '@warpstack/contract'
import { useMediaUrl } from '@warpstack/client/react'
import { Image as MediaImage } from 'expo-image'
import { useVideoPlayer, VideoView } from 'expo-video'
import { useState } from 'react'
import { Platform, Pressable, Text, View } from 'react-native'
import { PlayIcon } from './icons.tsx'
import { radius, space, type, useColors } from './theme.ts'

// A video in a cast. Only videos the server said may play reach here: from Farcaster's own
// video servers or this deployment's uploads. Nothing loads until the person taps: a tap is
// what reaches the video's host, and each play of the deployment's own uploads costs its owner.

type Video = Extract<EmbedMetadata, { kind: 'video' }>

/** The tallest a video gets in a list, like images. */
const MAX_VIDEO_HEIGHT = 400
const DEFAULT_ASPECT = 16 / 9

/** Whether this browser plays HLS itself (Safari does); without it, the web shows a link. */
export const webPlaysHls = (): boolean => {
  if (Platform.OS !== 'web' || typeof document === 'undefined') return true
  return document.createElement('video').canPlayType('application/vnd.apple.mpegurl') !== ''
}

const length = (seconds: number) => {
  const s = Math.round(seconds)
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

const Player = ({ url, aspect }: { url: string; aspect: number }) => {
  const player = useVideoPlayer(url, p => {
    p.loop = false
    p.play()
  })
  return (
    <VideoView player={player} nativeControls contentFit="contain" allowsPictureInPicture={false} fullscreenOptions={{ enable: true }}
      style={{ width: '100%', aspectRatio: aspect, maxHeight: MAX_VIDEO_HEIGHT, borderRadius: radius.md, backgroundColor: '#000' }} />
  )
}

export const VideoEmbed = ({ video }: { video: Video }) => {
  const c = useColors()
  const [playing, setPlaying] = useState(false)
  const poster = useMediaUrl(video.poster?.media)
  const aspect = video.width && video.height ? video.width / video.height
    : video.poster ? video.poster.width / video.poster.height
    : DEFAULT_ASPECT
  if (playing) return <Player url={video.url} aspect={aspect} />
  return (
    <Pressable accessibilityRole="button" accessibilityLabel={`Play video${video.duration ? `, ${length(video.duration)}` : ''}`} onPress={() => setPlaying(true)}>
      <View style={{ width: '100%', aspectRatio: aspect, maxHeight: MAX_VIDEO_HEIGHT, borderRadius: radius.md, overflow: 'hidden', backgroundColor: '#000', alignItems: 'center', justifyContent: 'center' }}>
        {poster && (
          <MediaImage source={{ uri: poster }} recyclingKey={poster} accessibilityIgnoresInvertColors contentFit="cover" transition={0}
            style={{ position: 'absolute', top: 0, right: 0, bottom: 0, left: 0 }} />
        )}
        <PlayIcon color="#fff" background="rgba(0,0,0,0.55)" />
        {video.duration !== undefined && (
          <View style={{ position: 'absolute', right: space.sm, bottom: space.sm, paddingHorizontal: 6, paddingVertical: 2, borderRadius: radius.sm, backgroundColor: 'rgba(0,0,0,0.6)' }}>
            <Text style={[type.small, { color: '#fff', fontVariant: ['tabular-nums'] }]}>{length(video.duration)}</Text>
          </View>
        )}
      </View>
      {!poster && <Text style={[type.small, { color: c.muted, marginTop: 4 }]} numberOfLines={1}>{video.domain}</Text>}
    </Pressable>
  )
}
