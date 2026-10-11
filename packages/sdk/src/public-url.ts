/** The code is safe to display without exposing the rejected configuration value. */
export class PublicUrlError extends Error {
  readonly code = 'invalid_public_url'

  constructor() {
    super('invalid_public_url')
    this.name = 'PublicUrlError'
  }
}

/** A deployment origin comes only from configuration, never an incoming request. */
export function validatePublicUrl(value: string): string {
  if (!/^https?:\/\/[^/?#\s\\]+\/?$/u.test(value) || !URL.canParse(value)) {
    throw new PublicUrlError()
  }
  const url = new URL(value)
  const authority = value.split('/')[2] ?? ''
  const local = /^(?:127\.0\.0\.1|\[::1\])(?::[0-9]+)?$/u.test(authority)
  if (
    authority.includes('@') ||
    url.username ||
    url.password ||
    url.pathname !== '/' ||
    (url.protocol !== 'https:' && !(url.protocol === 'http:' && local))
  ) {
    throw new PublicUrlError()
  }
  return url.origin
}
