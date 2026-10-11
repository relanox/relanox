import type { AgentId } from './config.js'

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

export type PutMediaInput = {
  readonly requestId: string
  readonly agent: AgentId
  readonly endpointIds: readonly string[]
  readonly media: StoredMedia
  readonly maxBytes: number
  readonly maxCount: number
  readonly maxTotalBytes: number
}

export type PutMediaResult =
  | { readonly status: 'stored'; readonly reference: MediaReference }
  | {
      readonly status:
        | 'unauthorized'
        | 'conflict'
        | 'invalid_media_preview'
        | 'media_too_large'
        | 'too_many_attachments'
        | 'media_total_too_large'
    }

/** Request-owned bytes are committed atomically with authorization and budgets. */
export type MediaStorage = {
  get(requestId: string, mediaId: string): Promise<StoredMedia | undefined>
  put(input: PutMediaInput): Promise<PutMediaResult>
}

export type AgentMediaHost = {
  readonly maxBytes: number
  readonly maxTotalBytes: number
  readonly maxAttachments: number
  /** Check ownership for upload ticket issuance without loading media bytes. */
  authorize(input: { readonly requestId: string }): Promise<boolean>
  /** An immutable request-owned ID may be retried with identical metadata and bytes. */
  upload(input: {
    readonly requestId: string
    readonly mediaId: string
    readonly upload: MediaUpload
  }): Promise<MediaReference | undefined>
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
