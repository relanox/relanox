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
  fileName: string,
  data: Uint8Array
): string {
  // QQ voice bytes can be Tencent SILK despite an .amr name or AMR metadata.
  const start = data[0] === 0x02 ? 1 : 0
  if (Buffer.from(data.subarray(start, start + 9)).toString() === '#!SILK_V3') {
    return 'audio/silk'
  }
  const inferred = lookup(fileName)
  return (
    normalizeSpecificMime(declared) ??
    normalizeSpecificMime(downloaded) ??
    (inferred === false ? 'application/octet-stream' : inferred)
  )
}
