import { lookup } from 'mime-types'

function normalizeSpecificMime(value: string | undefined): string | undefined {
  const mime = value?.split(';')[0]?.trim().toLowerCase()
  return mime &&
    mime.length <= 128 &&
    /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/u.test(mime) &&
    !['application/octet-stream', 'binary/octet-stream'].includes(mime)
    ? mime
    : undefined
}

/** QQ can label native attachments "voice"/"file", which are not MIME types. */
export function attachmentMimeType(
  declared: string | undefined,
  downloaded: string,
  fileName: string
): string {
  const inferred = lookup(fileName)
  return (
    normalizeSpecificMime(declared) ??
    normalizeSpecificMime(downloaded) ??
    (inferred === false ? 'application/octet-stream' : inferred)
  )
}
