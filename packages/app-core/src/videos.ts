import { VIDEO_LIMITS } from '@warpstack/contract'
import { launchImageLibraryAsync, UIImagePickerPreferredAssetRepresentationMode } from 'expo-image-picker'

// Videos to post, chosen from the library through the system picker, which shows the user's
// library without the app asking for access to it. Longer videos are trimmed in the picker to
// the server's limit, and the "compatible" representation hands over H.264 rather than HEVC.
// The file goes to the deployment's own Cloudflare Stream, which transcodes it: viewers only ever
// play Stream's copy, which carries none of the original's metadata, and the original isn't
// downloadable.

export type Video = { uri: string; width: number; height: number; duration: number | null }

/** A video the user picked; null if they cancelled. */
export const pickVideo = async (): Promise<Video | null> => {
  const picked = await launchImageLibraryAsync({
    mediaTypes: ['videos'],
    allowsEditing: true,
    videoMaxDuration: VIDEO_LIMITS.maxSeconds,
    allowsMultipleSelection: false,
    exif: false,
    preferredAssetRepresentationMode: UIImagePickerPreferredAssetRepresentationMode.Compatible,
  })
  const asset = picked.canceled ? undefined : picked.assets[0]
  if (!asset || asset.type !== 'video') return null
  return { uri: asset.uri, width: asset.width, height: asset.height, duration: asset.duration ? asset.duration / 1_000 : null }
}
