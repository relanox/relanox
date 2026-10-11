import { createHash } from 'node:crypto'
import type {
  MediaReference,
  StoredMedia,
  InboundSnapshot,
  EnqueueMessageInput
} from '@relanox/sdk'
import { encodeDurableRecord, equalDurableValues } from './record-codec.js'

export function validMedia(media: StoredMedia): boolean {
  const ref = media.reference
  return (
    typeof ref.id === 'string' &&
    ref.id.length > 0 &&
    ['image', 'audio', 'video', 'file'].includes(ref.kind) &&
    typeof ref.mimeType === 'string' &&
    typeof ref.fileName === 'string' &&
    (ref.durationMs === undefined ||
      (Number.isSafeInteger(ref.durationMs) && ref.durationMs > 0)) &&
    (ref.previewMediaId === undefined ||
      (typeof ref.previewMediaId === 'string' &&
        ref.previewMediaId.length > 0)) &&
    media.data instanceof Uint8Array &&
    ref.size === media.data.byteLength &&
    ref.sha256 === createHash('sha256').update(media.data).digest('hex')
  )
}

export function validateIncoming(
  snapshot: InboundSnapshot,
  media: readonly StoredMedia[]
): void {
  const refs = snapshot.attachments ?? []
  if (
    refs.length !== media.length ||
    new Set(refs.map((ref) => ref.id)).size !== refs.length ||
    !media.every(
      (asset, index) =>
        validMedia(asset) && equalDurableValues(asset.reference, refs[index])
    )
  ) {
    throw new TypeError('Inbound media does not match snapshot')
  }
}

export const sameReference = (
  left: MediaReference,
  right: MediaReference
): boolean => equalDurableValues(left, right)

export function withinMediaBudget(
  input: EnqueueMessageInput,
  count: number,
  bytes: number
): boolean {
  const maxCount = input.maxCount ?? 20
  const maxTotalBytes = input.maxTotalBytes ?? 200 * 1024 * 1024
  return (
    Number.isSafeInteger(maxCount) &&
    maxCount >= 0 &&
    Number.isSafeInteger(maxTotalBytes) &&
    maxTotalBytes >= 0 &&
    count <= maxCount &&
    bytes <= maxTotalBytes
  )
}

/** Resolve the complete attachment graph before any database writes. */
export function validateMessageMedia(
  input: EnqueueMessageInput,
  existing: readonly StoredMedia[]
): readonly StoredMedia[] | undefined {
  const assets = new Map(existing.map((asset) => [asset.reference.id, asset]))
  const additions: StoredMedia[] = []
  for (const asset of input.media ?? []) {
    if (!validMedia(asset)) {
      return undefined
    }
    const previous = assets.get(asset.reference.id)
    if (previous) {
      if (!sameReference(previous.reference, asset.reference)) {
        return undefined
      }
    } else {
      assets.set(asset.reference.id, asset)
      additions.push(asset)
    }
  }
  const refs = input.message.attachments ?? []
  const used = new Set<string>()
  for (const ref of refs) {
    const asset = assets.get(ref.id)
    if (!asset || !sameReference(asset.reference, ref)) {
      return undefined
    }
    used.add(ref.id)
    if (ref.previewMediaId !== undefined) {
      const preview = assets.get(ref.previewMediaId)
      if (
        preview?.reference.kind !== 'image' ||
        preview.reference.previewMediaId !== undefined
      ) {
        return undefined
      }
      used.add(ref.previewMediaId)
    }
  }
  if (additions.some((asset) => !used.has(asset.reference.id))) {
    return undefined
  }
  if (
    !withinMediaBudget(
      input,
      assets.size,
      [...assets.values()].reduce(
        (sum, asset) => sum + asset.data.byteLength,
        0
      )
    )
  ) {
    return undefined
  }
  return additions
}

export const mediaDigest = (media: StoredMedia): string =>
  createHash('sha256')
    .update(
      encodeDurableRecord([
        media.reference.id,
        media.reference.kind,
        media.reference.mimeType,
        media.reference.fileName,
        media.reference.size,
        media.reference.sha256,
        ...(media.reference.durationMs === undefined &&
        media.reference.previewMediaId === undefined
          ? []
          : [
              media.reference.durationMs ?? null,
              media.reference.previewMediaId ?? null
            ])
      ])
    )
    .digest('hex')
