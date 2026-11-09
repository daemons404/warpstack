// The untrusted-content fetchers (sealed core): the restricted transport, the image checks
// and link previews. A human approves every change here.
export { checkUrl, hostOf, type AddressPolicy } from './address.ts'
export { checkImage, contentTypeOf, IMAGE_POLICY, sniffImage, type ImageInfo, type ImageType } from './image.ts'
export { plainText, PREVIEW_CAPS, readPreview, type Preview } from './preview.ts'
export { IMAGE_LIMITS, MAX_CONCURRENT_FETCHES, PAGE_LIMITS, untrustedFetch, USER_AGENT, type FetchError, type Fetched, type FetchLimits, type FetchOptions } from './untrusted-fetch.ts'
