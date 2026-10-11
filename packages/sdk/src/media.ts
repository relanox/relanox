import type { AgentId } from './config.js'

export type MediaKind = 'image' | 'audio' | 'video' | 'file'

/** Binary data crosses a plugin boundary only in memory, never in JSON snapshots. */
export interface MediaUpload {
  readonly kind: MediaKind
  readonly mimeType: string
  readonly fileName: string
  /** Duration in milliseconds when required by the native platform. */
  readonly durationMs?: number
  /** Optional image asset owned by the same request, used as a native preview. */
  readonly previewMediaId?: string
  readonly data: Uint8Array
}

/** Stable metadata for bytes owned by this relay. Platform download URLs are not assets. */
export interface MediaReference {
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

export interface StoredMedia {
  readonly reference: MediaReference
  readonly data: Uint8Array
}

export type MediaWriteResult =
  | {
      readonly status: 'stored'
      readonly media: MediaReference
      readonly replay: boolean
    }
  | { readonly status: 'not_found' | 'unauthorized' | 'conflict' }

/** Media belongs to a request; writes use the same durable claim fence as completion. */
export interface MediaStorage {
  get(requestId: string, mediaId: string): Promise<StoredMedia | undefined>
  put(input: {
    readonly requestId: string
    readonly agent: AgentId
    readonly endpointIds: readonly string[]
    readonly claimToken: string
    readonly media: StoredMedia
    /** Atomic per-request budget, including input and staged output assets. */
    readonly maxCount?: number
    readonly maxTotalBytes?: number
  }): Promise<MediaWriteResult>
}

export interface AgentMediaHost {
  readonly maxBytes: number
  read(input: {
    readonly requestId: string
    readonly claimToken: string
    readonly mediaId: string
  }): Promise<StoredMedia | undefined>
  upload(input: {
    readonly requestId: string
    readonly claimToken: string
    /** A caller-generated UUID makes retried uploads idempotent. */
    readonly uploadId: string
    readonly media: MediaUpload
  }): Promise<MediaWriteResult>
}

/** Short-lived download URLs for native platforms that fetch outbound bytes themselves. */
export interface ChannelMediaHost {
  publish(input: {
    readonly requestId: string
    readonly mediaId: string
  }): Promise<string>
}
