export class MediaDownloadError extends Error {
  constructor(
    readonly code:
      | "forbidden_destination"
      | "media_too_large"
      | "media_download_failed"
      | "media_timeout",
    readonly status?: number,
  ) {
    super(code);
    this.name = "MediaDownloadError";
  }
}
