import { createHmac } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, expect, it, vi } from 'vitest'
import type { WorkerOptions } from '@relanox/core'
import {
  cleanup,
  databaseFile,
  httpPeer,
  json
} from '../../channel-matrix/tests/harness.js'
import {
  installPeerNetwork,
  registerPeer,
  routePlatform
} from '../../channel-wecom/tests/network.js'
import { createWhatsAppChannel } from '../src/index.js'
import { harness } from './harness.js'

installPeerNetwork()
afterEach(() => vi.unstubAllEnvs())

const maximum = 1024
const ordinaryFile = Buffer.from('ordinary customer document\n')

type Failure =
  | 'metadata'
  | 'content-length'
  | 'stream'
  | 'metadata-503'
  | 'binary-503'
  | 'invalid-metadata'
  | 'foreign-origin'
  | 'missing-credential'
  | 'none'

// Native document/text webhook fields: WhatsApp/WhatsApp-Nodejs-SDK
// @58ca3d5fceea604e18393734578d9a7944a37b15 src/types/webhooks.ts.
// Meta's media contract admits ordinary text/plain documents up to 100 MB:
// https://developers.facebook.com/documentation/business-messaging/whatsapp/business-phone-numbers/media#supported-media-types
// Retrieval returns the media ID, MIME type, byte size and temporary binary URL:
// https://developers.facebook.com/documentation/business-messaging/whatsapp/business-phone-numbers/media#get-media-url
function envelope(timestamp = Math.floor(Date.now() / 1000)): string {
  return JSON.stringify({
    object: 'whatsapp_business_account',
    entry: [
      {
        id: '102030405060708',
        changes: [
          {
            field: 'messages',
            value: {
              messaging_product: 'whatsapp',
              metadata: { phone_number_id: '10987654321' },
              messages: [
                {
                  id: 'wamid.document',
                  from: '15551234567',
                  timestamp: String(timestamp),
                  type: 'document',
                  document: {
                    id: '123456789',
                    mime_type: 'text/plain',
                    filename: 'report.txt',
                    caption: 'document caption'
                  }
                },
                {
                  id: 'wamid.text',
                  from: '15551234567',
                  timestamp: String(timestamp),
                  type: 'text',
                  text: { body: 'later legal text' }
                }
              ]
            }
          }
        ]
      }
    ]
  })
}

function incoming(encoded: string): Request {
  return new Request('https://relay.example/channels/business/webhook', {
    method: 'POST',
    headers: {
      'x-hub-signature-256': `sha256=${createHmac('sha256', 'app-secret').update(encoded).digest('hex')}`
    },
    body: encoded
  })
}

async function setup(
  initial: Failure,
  worker?: WorkerOptions
): Promise<{
  local: Awaited<ReturnType<typeof harness>>
  traffic: { path: string; authorization: string | undefined }[]
  recover(this: void): void
  filename: string
}> {
  vi.stubEnv('WA_POLICY_APP', 'app-secret')
  vi.stubEnv('WA_POLICY_VERIFY', 'verify')
  vi.stubEnv('WA_POLICY_TOKEN', 'access-secret')
  let failure = initial
  const traffic: { path: string; authorization: string | undefined }[] = []

  const graph = await httpPeer((request, response) => {
    const path = request.url ?? '/'
    traffic.push({ path, authorization: request.headers.authorization })
    if (path.startsWith('/v25.0/123456789')) {
      if (failure === 'metadata-503') {
        json(response, {}, 503)
        return
      }

      const metadata = {
        id: '123456789',
        url:
          failure === 'foreign-origin'
            ? 'https://foreign.example/binary'
            : 'https://lookaside.fbsbx.com/binary',
        mime_type: 'text/plain',
        ...(failure === 'invalid-metadata'
          ? {}
          : {
              file_size: String(
                failure === 'metadata' ? maximum + 1 : ordinaryFile.length
              )
            })
      }

      json(response, metadata)
      return
    }
    if (failure === 'binary-503') {
      json(response, {}, 503)
      return
    }
    response.setHeader('Content-Type', 'text/plain')
    if (failure === 'content-length') {
      response.setHeader('Content-Length', maximum + 1)
      response.end('x'.repeat(maximum + 1))
    } else if (failure === 'stream') {
      response.write('x'.repeat(maximum))
      response.end('x')
    } else {
      response.end(ordinaryFile)
    }
  })

  const destination = registerPeer(graph.base)
  routePlatform('https://graph.facebook.com', destination)
  routePlatform('https://lookaside.fbsbx.com', destination)
  const filename = await databaseFile()

  const local = await harness(
    createWhatsAppChannel(),
    {
      phoneNumberId: '10987654321',
      businessAccountId: '102030405060708',
      appSecret: { env: 'WA_POLICY_APP' },
      verifyToken: { env: 'WA_POLICY_VERIFY' },
      accessToken: { env: 'WA_POLICY_TOKEN' }
    },
    '15551234567',
    '15551234567',
    undefined,
    filename,
    worker ?? { maxMediaBytes: maximum }
  )

  cleanup(local.close)
  if (initial === 'missing-credential') {
    vi.stubEnv('WA_POLICY_TOKEN', '')
  }
  return {
    local,
    traffic,
    filename,
    recover() {
      failure = 'none'
      vi.stubEnv('WA_POLICY_TOKEN', 'access-secret')
    }
  }
}

it.each(['metadata', 'content-length', 'stream'] as const)(
  'acknowledges a known %s byte-limit refusal and dispatches later text once',
  async (failure) => {
    const { local, traffic } = await setup(failure)
    const encoded = envelope()
    expect((await local.core.fetch(incoming(encoded))).status).toBe(200)
    expect((await local.core.fetch(incoming(encoded))).status).toBe(200)
    await local.core.processDue()
    const records = await local.storage.listInbound({ limit: 10 })
    expect(records.map((record) => record.snapshot.text)).toEqual([
      'later legal text'
    ])
    expect(records[0]?.snapshot.attachments).toBeUndefined()
    expect(records[0]?.dispatch.status).toBe('accepted')
    expect(local.dispatches).toEqual(['later legal text'])
    expect(
      traffic.filter((request) => request.path === '/binary')
    ).toHaveLength(failure === 'metadata' ? 0 : 2)
    expect(
      traffic.every(
        (request) => request.authorization === 'Bearer access-secret'
      )
    ).toBe(true)
  }
)

it.each([
  'metadata-503',
  'binary-503',
  'invalid-metadata',
  'foreign-origin',
  'missing-credential'
] as const)(
  'preserves the whole webhook for recovery after %s',
  async (failure) => {
    const { local, recover } = await setup(failure)
    const encoded = envelope()
    expect((await local.core.fetch(incoming(encoded))).status).toBe(500)
    expect(await local.storage.listInbound({ limit: 10 })).toEqual([])
    recover()
    expect((await local.core.fetch(incoming(encoded))).status).toBe(200)
    expect((await local.core.fetch(incoming(encoded))).status).toBe(200)
    await local.core.processDue()
    const records = await local.storage.listInbound({ limit: 10 })
    expect(records.map((record) => record.snapshot.text).toSorted()).toEqual([
      'document caption',
      'later legal text'
    ])
    expect(
      records.every((record) => record.dispatch.status === 'accepted')
    ).toBe(true)
    expect(local.dispatches.toSorted()).toEqual([
      'document caption',
      'later legal text'
    ])

    const attachment = records.find(
      (record) => record.snapshot.text === 'document caption'
    )?.snapshot.attachments?.[0]

    expect(attachment).toMatchObject({
      kind: 'file',
      mimeType: 'text/plain',
      fileName: 'report.txt',
      size: 27
    })
  }
)

it.each([
  [26, ['later legal text']],
  [27, ['document caption', 'later legal text']]
] as const)(
  'acknowledges an ordinary 27-byte document under aggregate limit %s without blocking later text',
  async (maxTotalMediaBytes, expected) => {
    const { local, traffic } = await setup('none', {
      maxMediaBytes: maximum,
      maxTotalMediaBytes
    })

    const encoded = envelope()
    expect((await local.core.fetch(incoming(encoded))).status).toBe(200)
    expect((await local.core.fetch(incoming(encoded))).status).toBe(200)
    await local.core.processDue()
    const records = await local.storage.listInbound({ limit: 10 })
    expect(records.map((record) => record.snapshot.text).toSorted()).toEqual(
      expected
    )
    expect(local.dispatches.toSorted()).toEqual(expected)
    expect(
      records.every((record) => record.dispatch.status === 'accepted')
    ).toBe(true)
    expect(
      traffic.filter((request) => request.path === '/binary')
    ).toHaveLength(2)
  }
)

it('does not acknowledge a real SQLite write failure and accepts the replay after recovery', async () => {
  const { local, filename } = await setup('none')
  const database = new DatabaseSync(filename)
  try {
    // Two SQLite copies in one process do not share POSIX advisory lock state:
    // https://www.sqlite.org/howtocorrupt.html#multiple_copies_of_sqlite_linked_into_the_same_application
    // This real trigger fails only acceptInbound's INSERT, independent of driver
    // Locking behavior; window/state operations still use the production store.
    database.exec(
      "CREATE TRIGGER whatsapp_write_refusal BEFORE INSERT ON inbound BEGIN SELECT RAISE(FAIL, 'inbound_unavailable'); END"
    )
    const encoded = envelope()
    expect((await local.core.fetch(incoming(encoded))).status).toBe(500)
    expect(await local.storage.listInbound({ limit: 10 })).toEqual([])
    database.exec('DROP TRIGGER whatsapp_write_refusal')
    expect((await local.core.fetch(incoming(encoded))).status).toBe(200)
    await local.core.processDue()
    expect(local.dispatches.toSorted()).toEqual([
      'document caption',
      'later legal text'
    ])
  } finally {
    database.close()
  }
})
