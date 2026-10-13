import { afterEach, expect, it, vi } from 'vitest'
import { ingressFixture } from './ingress-fixture.js'
import { mediaPeer } from './media-peer.js'

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const close of cleanups.splice(0).toReversed()) {
    await close()
  }
  vi.unstubAllEnvs()
})

// Telegram-bot-api e3e9dd8e5b3d7ab8537cd5a10dc31d5ffa8f82d1 Client.cpp
// JsonVoiceNote emits TD's duration unchanged. TD c15d3f5a5de6e3ba5839822c451152e5e18bb700
// VoiceNotesManager.cpp create_voice_note uses max(duration, 0), and
// Get_voice_note_object returns that value. A zero native duration is legal.
it.each([
  { seconds: 0, durationMs: undefined },
  { seconds: 2, durationMs: 2000 }
])(
  'persists a native $seconds-second voice and preserves known duration through restart',
  async ({ seconds, durationMs }) => {
    const data = Uint8Array.of(1, 2, 3)

    const remote = await mediaPeer((traffic) =>
      traffic.method === 'GET'
        ? { data, mimeType: 'audio/ogg' }
        : {
            json: {
              ok: true,
              result: {
                file_id: 'native-voice',
                file_unique_id: 'voice-unique',
                file_size: 3,
                file_path: 'voice/file_1.oga'
              }
            }
          }
    )

    cleanups.push(remote.close)
    const fixture = await ingressFixture(cleanups, remote.origin, {})
    let runtime = await fixture.start()

    const body = {
      update_id: 700,
      message: {
        message_id: 9,
        message_thread_id: 8,
        date: 1_760_000_000,
        from: { id: 42, is_bot: false, first_name: 'User' },
        chat: { id: -1007, type: 'supergroup', title: 'Voice' },
        voice: {
          file_id: 'native-voice',
          file_unique_id: 'voice-unique',
          duration: seconds,
          mime_type: 'audio/ogg',
          file_size: 3
        }
      }
    }

    expect(
      (
        await fetch(`${runtime.origin}/channels/telegram/webhook`, {
          method: 'POST',
          headers: { 'x-telegram-bot-api-secret-token': 'secret' },
          body: JSON.stringify(body)
        })
      ).status
    ).toBe(204)
    expect(fixture.routine.traffic).toEqual([])
    await runtime.stop()
    runtime = await fixture.start()
    const requests = (await runtime.core.status()).requests
    expect(requests).toHaveLength(1)
    const request = requests[0]?.snapshot
    const attachment = request?.attachments?.[0]
    expect(attachment).toMatchObject({
      kind: 'audio',
      mimeType: 'audio/ogg',
      size: 3,
      fileName: 'file_1.oga'
    })
    expect(attachment?.durationMs).toBe(durationMs)
    if (!request || !attachment) {
      throw new Error('missing_saved_voice')
    }
    expect(
      (await runtime.storage.media?.get(request.channel.id, attachment.id))
        ?.data
    ).toEqual(data)
    await runtime.core.processDue()
    expect(fixture.routine.traffic).toHaveLength(1)
  }
)
