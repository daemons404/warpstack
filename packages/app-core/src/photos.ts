import { ImageManipulator, SaveFormat } from 'expo-image-manipulator'
import { launchImageLibraryAsync } from 'expo-image-picker'

// Photos to post. Chosen from the library, then resized
// and re-encoded on the device before anything is sent: re-encoding writes a new JPEG from the
// pixels alone, so location, camera and other metadata never leave the phone. The server
// checks for it anyway, refuses an image that still carries any, and re-encodes again.

/** The longest edge sent: the server stores posted images at most 1,080 wide. */
export const PHOTO_MAX_EDGE = 2_048

export type Photo = { uri: string; width: number; height: number }

/** A photo the user picked, prepared for upload; null if they cancelled. */
export const pickPhoto = async (): Promise<Photo | null> => {
  // The system photo picker: it shows the user's library without the app asking for access to it.
  const picked = await launchImageLibraryAsync({ mediaTypes: ['images'], quality: 1, exif: false, allowsMultipleSelection: false })
  const asset = picked.canceled ? undefined : picked.assets[0]
  if (!asset) return null
  const scale = Math.min(1, PHOTO_MAX_EDGE / Math.max(asset.width, asset.height))
  const context = ImageManipulator.manipulate(asset.uri)
  if (scale < 1) context.resize({ width: Math.round(asset.width * scale), height: Math.round(asset.height * scale) })
  const image = await context.renderAsync()
  const saved = await image.saveAsync({ format: SaveFormat.JPEG, compress: 0.85 })
  return { uri: saved.uri, width: saved.width, height: saved.height }
}
