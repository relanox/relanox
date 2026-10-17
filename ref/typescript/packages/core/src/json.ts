import type { Json } from '@relanox/sdk'
import { z } from 'zod'

/** Persist only JSON values; cloning must not materialize environment-backed secrets. */
export function jsonSnapshot<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

export function validateJson(value: unknown): Json {
  return z.json().parse(value)
}

/** Stable JSON identity ignores object property order while preserving array order. */
export function canonicalJson(value: unknown): string {
  const canonical = (candidate: unknown): unknown => {
    if (Array.isArray(candidate)) {
      return candidate.map(canonical)
    }
    if (candidate !== null && typeof candidate === 'object') {
      return Object.fromEntries(
        Object.entries(candidate)
          .toSorted(([a], [b]) => a.localeCompare(b))
          .map(([key, item]) => [key, canonical(item)])
      )
    }
    return candidate
  }

  return JSON.stringify(canonical(value))
}
