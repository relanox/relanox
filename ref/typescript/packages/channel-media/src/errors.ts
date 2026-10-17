export class MediaDownloadError extends Error {
  constructor(
    readonly code:
      | 'forbidden_destination'
      | 'media_too_large'
      | 'media_download_failed'
      | 'media_timeout',
    readonly status?: number,
    /** Parsed JSON from a failed native HTTP response, bounded to 64 KiB. */
    readonly responseBody?: unknown
  ) {
    super(code)
    this.name = 'MediaDownloadError'
  }
}
