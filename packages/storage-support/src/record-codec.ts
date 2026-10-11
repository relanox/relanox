import type { OutboundMessage } from '@relanox/sdk'
import { createHash } from 'node:crypto'

export const encodeDurableRecord = (value: unknown): string => {
  const ancestors = new Set<object>()

  const validateJsonValue = (candidate: unknown): void => {
    if (
      candidate === null ||
      typeof candidate === 'string' ||
      typeof candidate === 'boolean'
    ) {
      return
    }
    if (typeof candidate === 'number' && Number.isFinite(candidate)) {
      return
    }
    if (typeof candidate !== 'object' || ancestors.has(candidate)) {
      throw new TypeError('Non-JSON durable value')
    }
    if (
      !Array.isArray(candidate) &&
      Object.getPrototypeOf(candidate) !== Object.prototype
    ) {
      throw new TypeError('Non-plain durable value')
    }
    ancestors.add(candidate)
    for (const child of Object.values(candidate)) {
      validateJsonValue(child)
    }
    ancestors.delete(candidate)
  }

  validateJsonValue(value)
  return JSON.stringify(value)
}

export const messageDigest = (message: OutboundMessage): string =>
  createHash('sha256')
    .update(
      encodeDurableRecord([
        message.text,
        (message.attachments ?? []).map((ref) => [
          ref.id,
          ref.kind,
          ref.mimeType,
          ref.fileName,
          ref.size,
          ref.sha256,
          ref.durationMs ?? null,
          ref.previewMediaId ?? null
        ])
      ])
    )
    .digest('hex')

export const equalDurableValues = (a: unknown, b: unknown): boolean => {
  const canonical = (value: unknown): unknown => {
    if (Array.isArray(value)) {
      return value.map(canonical)
    }
    if (value !== null && typeof value === 'object') {
      return Object.fromEntries(
        Object.entries(value)
          .toSorted(([left], [right]) => left.localeCompare(right))
          .map(([key, child]) => [key, canonical(child)])
      )
    }
    return value
  }

  return encodeDurableRecord(canonical(a)) === encodeDurableRecord(canonical(b))
}
