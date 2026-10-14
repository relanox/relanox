import type { MessageMiddleware } from '@relanox/sdk'
import { z } from 'zod'

export function validateMiddleware(
  middleware: readonly MessageMiddleware[]
): void {
  const ids = middleware.map(({ id }) =>
    z
      .string()
      .regex(/^[a-z][a-z0-9-]{0,63}$/u)
      .parse(id)
  )

  if (ids.length > 16 || new Set(ids).size !== ids.length) {
    throw new Error('invalid_middleware_configuration')
  }
}
