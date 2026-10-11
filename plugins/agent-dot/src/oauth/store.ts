import { createHmac } from 'node:crypto'
import type { Json, StateEntry, StateStore } from '@relanox/sdk'
import type { z } from 'zod'
import { OAuthError, opaque } from './protocol.js'

export type OAuthStore = {
  read(kind: string, value: string): Promise<StateEntry | undefined>
  save(kind: string, value: string, data: Json, lifetime: number): Promise<void>
  issue(kind: string, data: Json, lifetime: number): Promise<string>
  consume(entry: StateEntry): Promise<void>
  update(entry: StateEntry, data: Json): Promise<void>
  capacity(kind: string): Promise<void>
  load<T>(
    kind: string,
    value: string,
    schema: z.ZodType<T>
  ): Promise<{ entry: StateEntry; data: T }>
}

/** Durable, endpoint-scoped opaque credentials. Changing the configured secret revokes old grants. */
export function createOAuthStore(
  state: StateStore,
  endpointId: string,
  secret: string
): OAuthStore {
  const prefix = `oauth/${endpointId}/`

  const keyFor = (kind: string, value: string): string =>
    `${prefix}${kind}/${createHmac('sha256', secret).update(value).digest('hex')}`

  async function read(
    kind: string,
    value: string
  ): Promise<StateEntry | undefined> {
    const entry = await state.get(keyFor(kind, value))
    return entry && (entry.expiresAt ?? 0) > Date.now() ? entry : undefined
  }

  async function save(
    kind: string,
    value: string,
    data: Json,
    lifetime: number
  ): Promise<void> {
    const result = await state.compareAndSet({
      key: keyFor(kind, value),
      expectedVersion: null,
      value: data,
      expiresAt: Date.now() + lifetime
    })

    if (result.status !== 'updated') {
      throw new OAuthError('temporarily_unavailable', 503)
    }
  }

  async function issue(
    kind: string,
    data: Json,
    lifetime: number
  ): Promise<string> {
    const value = opaque()
    await save(kind, value, data, lifetime)
    return value
  }

  async function consume(entry: StateEntry): Promise<void> {
    if ((await state.delete(entry.key, entry.version)).status !== 'updated') {
      throw new OAuthError('invalid_grant')
    }
  }

  async function update(entry: StateEntry, data: Json): Promise<void> {
    const result = await state.compareAndSet({
      key: entry.key,
      expectedVersion: entry.version,
      value: data,
      ...(entry.expiresAt === undefined ? {} : { expiresAt: entry.expiresAt })
    })

    if (result.status !== 'updated') {
      throw new OAuthError('invalid_grant')
    }
  }

  async function capacity(kind: string): Promise<void> {
    const entries = await state.list({
      prefix: `${prefix}${kind}/`,
      limit: 1000
    })

    for (const entry of entries) {
      if ((entry.expiresAt ?? 0) <= Date.now()) {
        await state.delete(entry.key, entry.version)
      }
    }
    if (
      entries.filter((entry) => (entry.expiresAt ?? 0) > Date.now()).length >=
      1000
    ) {
      throw new OAuthError('temporarily_unavailable', 503)
    }
  }

  async function load<T>(
    kind: string,
    value: string,
    schema: z.ZodType<T>
  ): Promise<{ entry: StateEntry; data: T }> {
    const entry = await read(kind, value)
    const parsed = schema.safeParse(entry?.value)
    if (!entry || !parsed.success) {
      throw new OAuthError('invalid_grant')
    }
    return { entry, data: parsed.data }
  }

  return { read, save, issue, consume, update, capacity, load }
}
