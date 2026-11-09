import { err, ok, type Result } from '@warpstack/protocol'

// What an image really is (sealed core; uploads and hostile content in previews).
// The type comes from the file's own first bytes, never its name or a Content-Type header:
// JPEG, PNG, WebP or GIF, and nothing else, so an SVG, an HTML page or a script renamed
// `.jpg` is refused. Dimensions and frame counts come from the headers, read with bounds
// checks on every access, and nothing is decoded: a malformed file is refused, not repaired.
//
// These checks decide what is worth handing to Cloudflare's Images binding; they are not what
// keeps phones safe. An exploit can hide in pixel data that only a decoder reaches, so every
// image is re-encoded by Cloudflare before any phone sees it, and nothing is passed through.
//
// `metadata` reports EXIF and XMP in JPEG, WebP and PNG, PNG text chunks, and JPEG IPTC. The
// Worker checks it on the re-encoded output: nothing that still carries metadata is stored or
// served. (It isn't checked on uploads, because iOS's JPEG encoder always writes a small EXIF
// block; the original never leaves the Worker.)

export type ImageType = 'jpeg' | 'png' | 'webp' | 'gif'
export type ImageInfo = { type: ImageType; width: number; height: number; frames: number; metadata: boolean }

export const IMAGE_POLICY = { maxPixels: 50_000_000, maxFrames: 300 } as const

const CONTENT_TYPES: Record<ImageType, string> = { jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', gif: 'image/gif' }
export const contentTypeOf = (t: ImageType) => CONTENT_TYPES[t]

const ascii = (b: Uint8Array, at: number, s: string) => {
  if (at + s.length > b.length) return false
  for (let i = 0; i < s.length; i++) if (b[at + i] !== s.charCodeAt(i)) return false
  return true
}
const u16be = (b: Uint8Array, i: number) => ((b[i] ?? 0) << 8) | (b[i + 1] ?? 0)
const u16le = (b: Uint8Array, i: number) => (b[i] ?? 0) | ((b[i + 1] ?? 0) << 8)
const u24le = (b: Uint8Array, i: number) => (b[i] ?? 0) | ((b[i + 1] ?? 0) << 8) | ((b[i + 2] ?? 0) << 16)
const u32be = (b: Uint8Array, i: number) => (((b[i] ?? 0) << 24) >>> 0) + (((b[i + 1] ?? 0) << 16) | ((b[i + 2] ?? 0) << 8) | (b[i + 3] ?? 0))
const u32le = (b: Uint8Array, i: number) => ((b[i] ?? 0) | ((b[i + 1] ?? 0) << 8) | ((b[i + 2] ?? 0) << 16)) + (((b[i + 3] ?? 0) << 24) >>> 0)

const png = (b: Uint8Array): ImageInfo | null => {
  if (!ascii(b, 0, '\x89PNG\r\n\x1a\n') || !ascii(b, 12, 'IHDR') || b.length < 33) return null
  const width = u32be(b, 16)
  const height = u32be(b, 20)
  let frames = 1
  let metadata = false
  for (let i = 8; i + 12 <= b.length;) {
    const len = u32be(b, i)
    const type = String.fromCharCode(b[i + 4]!, b[i + 5]!, b[i + 6]!, b[i + 7]!)
    if (type === 'acTL' && i + 12 <= b.length) frames = Math.max(1, u32be(b, i + 8))
    if (type === 'tEXt' || type === 'iTXt' || type === 'zTXt' || type === 'eXIf') metadata = true
    if (type === 'IEND') break
    const next = i + 12 + len
    if (next <= i || next > b.length) break
    i = next
  }
  return { type: 'png', width, height, frames, metadata }
}

const gif = (b: Uint8Array): ImageInfo | null => {
  if (!(ascii(b, 0, 'GIF87a') || ascii(b, 0, 'GIF89a')) || b.length < 13) return null
  let width = u16le(b, 6)
  let height = u16le(b, 8)
  const flags = b[10]!
  let i = 13 + (flags & 0x80 ? 3 * (1 << ((flags & 7) + 1)) : 0)
  let frames = 0
  const skipSubBlocks = () => {
    while (i < b.length) {
      const n = b[i]!
      i += 1
      if (n === 0) return true
      i += n
    }
    return false
  }
  while (i < b.length) {
    const block = b[i]!
    if (block === 0x3b) break
    if (block === 0x21) {
      i += 2
      if (!skipSubBlocks()) break
    } else if (block === 0x2c) {
      if (i + 10 > b.length) break
      frames++
      // A frame larger than the logical screen still costs its own pixels to decode.
      width = Math.max(width, u16le(b, i + 5))
      height = Math.max(height, u16le(b, i + 7))
      const f = b[i + 9]!
      i += 10 + (f & 0x80 ? 3 * (1 << ((f & 7) + 1)) : 0) + 1
      if (!skipSubBlocks()) break
      if (frames > IMAGE_POLICY.maxFrames) break
    } else {
      return null
    }
  }
  return frames ? { type: 'gif', width, height, frames, metadata: false } : null
}

const webp = (b: Uint8Array): ImageInfo | null => {
  if (!ascii(b, 0, 'RIFF') || !ascii(b, 8, 'WEBP') || b.length < 30) return null
  let width = 0
  let height = 0
  let frames = 0
  let metadata = false
  for (let i = 12; i + 8 <= b.length;) {
    const len = u32le(b, i + 4)
    if (ascii(b, i, 'VP8 ') && i + 18 <= b.length) {
      width ||= u16le(b, i + 14) & 0x3fff
      height ||= u16le(b, i + 16) & 0x3fff
    } else if (ascii(b, i, 'VP8L') && i + 13 <= b.length) {
      const b1 = b[i + 9]!, b2 = b[i + 10]!, b3 = b[i + 11]!, b4 = b[i + 12]!
      width ||= 1 + (((b2 & 0x3f) << 8) | b1)
      height ||= 1 + (((b4 & 0x0f) << 10) | (b3 << 2) | ((b2 & 0xc0) >> 6))
    } else if (ascii(b, i, 'VP8X') && i + 18 <= b.length) {
      width = 1 + u24le(b, i + 12)
      height = 1 + u24le(b, i + 15)
    } else if (ascii(b, i, 'ANMF')) {
      frames++
    } else if (ascii(b, i, 'EXIF') || ascii(b, i, 'XMP ')) {
      metadata = true
    }
    const next = i + 8 + len + (len & 1)
    if (next <= i || next > b.length) break
    i = next
  }
  return width && height ? { type: 'webp', width, height, frames: Math.max(1, frames), metadata } : null
}

const SOF = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf])

const jpeg = (b: Uint8Array): ImageInfo | null => {
  if (b[0] !== 0xff || b[1] !== 0xd8 || b[2] !== 0xff) return null
  let width = 0
  let height = 0
  let metadata = false
  let i = 2
  while (i + 4 <= b.length) {
    if (b[i] !== 0xff) return null
    const marker = b[i + 1]!
    if (marker === 0xff) {
      i += 1
      continue
    }
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      i += 2
      continue
    }
    if (marker === 0xd9 || marker === 0xda) break
    const len = u16be(b, i + 2)
    if (len < 2) return null
    if (SOF.has(marker) && i + 9 <= b.length) {
      height = u16be(b, i + 5)
      width = u16be(b, i + 7)
    }
    // APP1 carries EXIF and XMP; APP13 carries Photoshop IPTC.
    if (marker === 0xe1 && (ascii(b, i + 4, 'Exif\0') || ascii(b, i + 4, 'http://ns.adobe.com/xap'))) metadata = true
    if (marker === 0xed) metadata = true
    i += 2 + len
  }
  return width && height ? { type: 'jpeg', width, height, frames: 1, metadata } : null
}

/** What the bytes are, if they are one of the four accepted types with readable headers. */
export const sniffImage = (b: Uint8Array): ImageInfo | null => png(b) ?? gif(b) ?? webp(b) ?? jpeg(b)

/** The image, if it is an accepted type within the size and frame limits. */
export const checkImage = (b: Uint8Array): Result<ImageInfo, string> => {
  const info = sniffImage(b)
  if (!info) return err('not a JPEG, PNG, WebP or GIF')
  if (info.width < 1 || info.height < 1) return err('no dimensions')
  if (info.width * info.height > IMAGE_POLICY.maxPixels) return err('too many pixels')
  if (info.frames > IMAGE_POLICY.maxFrames) return err('too many frames')
  return ok(info)
}
