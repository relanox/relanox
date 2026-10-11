export type MediaKind = 'image' | 'audio' | 'video' | 'file'

/** Binary data crosses a plugin boundary only in memory, never in JSON snapshots. */
export type MediaUpload = {
  readonly kind: MediaKind
  readonly mimeType: string
  readonly fileName: string
  /** Duration in milliseconds when required by the native platform. */
  readonly durationMs?: number
  /** Optional image asset owned by the same request, used as a native preview. */
  readonly previewMediaId?: string
  readonly data: Uint8Array
}

/** A generated attachment may carry native preview bytes in the same atomic enqueue. */
export type AgentAttachment =
  | string
  | MediaUpload
  | {
      readonly media: MediaUpload
      readonly preview: MediaUpload
    }

/** Stable metadata for bytes owned by this relay. Platform download URLs are not assets. */
export type MediaReference = {
  readonly id: string
  readonly kind: MediaKind
  readonly mimeType: string
  readonly fileName: string
  /** Duration in milliseconds when required by the native platform. */
  readonly durationMs?: number
  /** Optional image asset owned by the same request, used as a native preview. */
  readonly previewMediaId?: string
  readonly size: number
  readonly sha256: string
}

export type StoredMedia = {
  readonly reference: MediaReference
  readonly data: Uint8Array
}

/** Bytes are published only as part of atomic message acceptance or enqueue. */
export type MediaStorage = {
  get(requestId: string, mediaId: string): Promise<StoredMedia | undefined>
}

export type AgentMediaHost = {
  readonly maxBytes: number
  readonly maxTotalBytes: number
  readonly maxAttachments: number
  read(input: {
    readonly requestId: string
    readonly mediaId: string
  }): Promise<StoredMedia | undefined>
}

/** Short-lived download URLs for native platforms that fetch outbound bytes themselves. */
export type ChannelMediaHost = {
  publish(input: {
    readonly requestId: string
    readonly mediaId: string
  }): Promise<string>
}
