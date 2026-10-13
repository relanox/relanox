import { MIMEType } from 'node:util'

/** Keep only a usable basename, matching the durable media filename boundary. */
function safeFileName(value: string | undefined): string | undefined {
  const basename = value?.split(/[\\/]/u).at(-1)
  const name = basename?.trim()
  if (
    !name ||
    name.length > 255 ||
    !name.isWellFormed() ||
    /\p{Cc}/u.test(basename ?? '') ||
    name === '.' ||
    name === '..'
  ) {
    return undefined
  }
  return name
}

function utf8FileName(value: string | null): string | undefined {
  const encoded = value?.match(/^utf-8'[^']*'(?<encoded>.*)$/iu)?.groups
    ?.encoded

  if (encoded === undefined) {
    return undefined
  }
  try {
    return safeFileName(decodeURIComponent(encoded))
  } catch {
    return undefined
  }
}

/** RFC 6266: prefer the extended UTF-8 name and ignore unusable metadata. */
export function responseFileName(
  header: string | undefined
): string | undefined {
  if (!header) {
    return undefined
  }
  try {
    // Both headers share MIME parameter syntax, including quoted strings and escapes.
    const { params } = new MIMEType(`application/${header}`)
    return (
      utf8FileName(params.get('filename*')) ??
      safeFileName(params.get('filename') ?? undefined)
    )
  } catch {
    return undefined
  }
}
