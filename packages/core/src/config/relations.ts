import type { z } from 'zod'
import type { configShapeSchema } from './schema.js'

/** Preserve tuple boundaries and distinguish the absent thread from any explicit platform ID. */
export function bindingKey(
  accountId: string,
  chatId: string,
  threadId?: string
): string {
  return JSON.stringify([accountId, chatId, threadId ?? null])
}

export function validateConfigRelations(
  value: z.output<typeof configShapeSchema>,
  context: z.RefinementCtx
): void {
  for (const key of ['accounts', 'endpoints'] as const) {
    const seen = new Set<string>()
    for (const item of value[key]) {
      if (seen.has(item.id)) {
        context.addIssue({
          code: 'custom',
          message: `Duplicate ${key} id`,
          path: [key]
        })
      }
      seen.add(item.id)
    }
  }
  const bindings = new Set<string>()
  for (const binding of value.bindings) {
    if (
      !value.accounts.some((account) => account.id === binding.accountId) ||
      !value.endpoints.some((endpoint) => endpoint.id === binding.endpointId)
    ) {
      context.addIssue({
        code: 'custom',
        message: 'Unknown binding account or endpoint',
        path: ['bindings']
      })
    }
    const key = bindingKey(binding.accountId, binding.chatId, binding.threadId)
    if (bindings.has(key)) {
      context.addIssue({
        code: 'custom',
        message: 'Duplicate conversation binding',
        path: ['bindings']
      })
    }
    bindings.add(key)
  }
}
