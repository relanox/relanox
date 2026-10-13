import type { ChannelHost } from '@relanox/sdk'
import { z } from 'zod'
import type { frameSchema } from './schemas.js'

const cursorSchema = z.object({
  serverUrl: z.string(),
  botUserId: z.string(),
  connectionId: z.string().regex(/^[a-z0-9]{26}$/u),
  nextSequence: z.number().int().nonnegative()
})

export async function websocketResume(
  host: ChannelHost,
  serverUrl: string,
  botUserId: string
): Promise<{
  query(url: URL): void
  check(frame: z.infer<typeof frameSchema>): void
  accept(frame: z.infer<typeof frameSchema>): Promise<void>
}> {
  const key = 'websocket-resume'
  let entry = await host.state.get(key)
  const saved = cursorSchema.safeParse(entry?.value)

  let cursor =
    saved.success &&
    saved.data.serverUrl === serverUrl &&
    saved.data.botUserId === botUserId
      ? saved.data
      : undefined

  return {
    query(url) {
      if (cursor) {
        url.searchParams.set('connection_id', cursor.connectionId)
        url.searchParams.set('sequence_number', String(cursor.nextSequence))
      }
    },
    check(frame) {
      if (
        cursor &&
        frame.event &&
        frame.event !== 'hello' &&
        frame.seq !== cursor.nextSequence
      ) {
        throw new Error('websocket_sequence_mismatch')
      }
    },
    async accept(frame) {
      if (frame.event === 'hello') {
        const hello = z
          .object({ connection_id: cursorSchema.shape.connectionId })
          .parse(frame.data)

        if (cursor && cursor.connectionId !== hello.connection_id) {
          host.observe.log('warn', 'operation.failed', {
            operation: 'receive',
            errorCode: 'websocket_replay_unavailable'
          })
        }
        cursor = {
          serverUrl,
          botUserId,
          connectionId: hello.connection_id,
          nextSequence: (frame.seq ?? 0) + 1
        }
      } else if (cursor && frame.event && frame.seq !== undefined) {
        cursor = { ...cursor, nextSequence: frame.seq + 1 }
      } else {
        return
      }

      const result = await host.state.compareAndSet({
        key,
        expectedVersion: entry?.version ?? null,
        value: cursor
      })

      if (result.status !== 'updated') {
        throw new Error('websocket_resume_save_failed')
      }
      entry = { key, value: cursor, version: result.version }
    }
  }
}
