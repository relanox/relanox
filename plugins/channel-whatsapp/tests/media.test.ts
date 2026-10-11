import { createHmac } from 'node:crypto'
import { expect, it, vi } from 'vitest'
import { body, httpPeer, json } from '../../channel-matrix/tests/harness.js'
import { mediaRelay } from '../../channel-matrix/tests/media-harness.js'
import { createWhatsAppChannel } from '../src/index.js'

const kinds = [
  ['image', 'image/png', 'image.png'],
  ['audio', 'audio/ogg', 'audio.ogg'],
  ['video', 'video/mp4', 'video.mp4'],
  ['file', 'application/pdf', 'report.pdf']
] as const

function envelope(type: string, fileName: string, sender = 'customer'): string {
  return JSON.stringify({
    object: 'whatsapp_business_account',
    entry: [
      {
        id: 'business',
        changes: [
          {
            field: 'messages',
            value: {
              metadata: { phone_number_id: 'phone' },
              messages: [
                {
                  id: 'incoming',
                  from: sender,
                  timestamp: String(Math.floor(Date.now() / 1000)),
                  type,
                  [type]: {
                    id: 'original',
                    ...(type === 'document'
                      ? { filename: fileName, caption: 'media caption' }
                      : {})
                  }
                }
              ]
            }
          }
        ]
      }
    ]
  })
}

async function webhook(
  businessUrl: string,
  encoded: string,
  correct = true
): Promise<Response> {
  return fetch(`${businessUrl}/channels/bot/webhook`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Hub-Signature-256': `sha256=${createHmac(
        'sha256',
        correct ? 'app-secret' : 'wrong-secret'
      )
        .update(encoded)
        .digest('hex')}`
    },
    body: encoded
  })
}

function config(base: string): {
  phoneNumberId: string
  businessAccountId: string
  apiVersion: string
  appSecret: { env: string }
  verifyToken: { env: string }
  accessToken: { env: string }
  apiBase: string
  allowLoopback: boolean
} {
  vi.stubEnv('WA_MEDIA_APP', 'app-secret')
  vi.stubEnv('WA_MEDIA_VERIFY', 'verify')
  vi.stubEnv('WA_MEDIA_TOKEN', 'access-secret')
  return {
    phoneNumberId: 'phone',
    businessAccountId: 'business',
    apiVersion: 'v25.0',
    appSecret: { env: 'WA_MEDIA_APP' },
    verifyToken: { env: 'WA_MEDIA_VERIFY' },
    accessToken: { env: 'WA_MEDIA_TOKEN' },
    apiBase: base,
    allowLoopback: true
  }
}

it.each(kinds)(
  'relays signed WhatsApp %s through Graph metadata, SQLite, real MCP and multipart native output',
  async (kind, mimeType, fileName) => {
    const downloads: { path: string; authorization: string | undefined }[] = []

    const uploaded: {
      bytes: Uint8Array
      contentType: string
      authorization: string | undefined
    }[] = []

    const sent: unknown[] = []
    const nativeType = kind === 'file' ? 'document' : kind

    const peer = await httpPeer(async (request, response) => {
      const url = new URL(request.url ?? '/', 'http://peer')
      if (url.pathname === '/v25.0/original') {
        downloads.push({
          path: request.url ?? '',
          authorization: request.headers.authorization
        })
        json(response, {
          id: 'original',
          url: `${peer.base}/binary`,
          mime_type: kind === 'audio' ? `${mimeType}; codecs=opus` : mimeType,
          file_size: '3'
        })
      } else if (url.pathname === '/binary') {
        downloads.push({
          path: url.pathname,
          authorization: request.headers.authorization
        })
        response.writeHead(200, { 'Content-Type': mimeType })
        response.end(new Uint8Array([1, 2, 3]))
      } else if (url.pathname === '/v25.0/phone/media') {
        const chunks: Uint8Array[] = []
        for await (const chunk of request) {
          chunks.push(chunk as Uint8Array)
        }
        uploaded.push({
          bytes: new Uint8Array(Buffer.concat(chunks)),
          contentType: request.headers['content-type'] ?? '',
          authorization: request.headers.authorization
        })
        json(response, { id: 'generated' })
      } else {
        sent.push(await body(request))
        json(response, {
          messaging_product: 'whatsapp',
          messages: [{ id: 'sent' }]
        })
      }
    })

    const fixture = await mediaRelay(
      createWhatsAppChannel(),
      config(peer.base),
      [{ chatId: 'customer' }],
      ['customer']
    )

    expect(
      (
        await webhook(
          fixture.businessUrl,
          envelope(nativeType, fileName),
          false
        )
      ).status
    ).toBe(401)
    expect(downloads).toEqual([])
    expect(
      (await webhook(fixture.businessUrl, envelope(nativeType, fileName)))
        .status
    ).toBe(200)
    const record = (await fixture.storage.listInbound({ limit: 10 }))[0]
    if (!record) {
      throw new Error('Expected inbound')
    }
    expect(record.snapshot.text).toBe(kind === 'file' ? 'media caption' : '')

    const turn = await fixture.turn(record.snapshot.requestId, [
      { kind, mimeType, fileName, data: new Uint8Array([9, 8, 7]) }
    ])

    expect(turn.inbound[0]?.reference).toMatchObject({
      kind,
      mimeType,
      fileName
    })
    expect(turn.inbound[0]?.data).toEqual(new Uint8Array([1, 2, 3]))
    expect(downloads).toEqual([
      {
        path: '/v25.0/original?phone_number_id=phone',
        authorization: 'Bearer access-secret'
      },
      { path: '/binary', authorization: 'Bearer access-secret' }
    ])
    await fixture.runtime.processDue()
    expect(uploaded).toHaveLength(1)
    const upload = uploaded[0]
    if (!upload) {
      throw new Error('Expected upload')
    }

    const form = await new Response(new Uint8Array(upload.bytes), {
      headers: { 'Content-Type': upload.contentType }
    }).formData()

    const file = form.get('file')
    if (!(file instanceof File)) {
      throw new Error('Expected multipart file')
    }
    expect(form.get('messaging_product')).toBe('whatsapp')
    expect(form.get('type')).toBe(mimeType)
    expect(file.name).toBe(fileName)
    expect(file.type).toBe(mimeType)
    expect(new Uint8Array(await file.arrayBuffer())).toEqual(
      new Uint8Array([9, 8, 7])
    )
    expect(upload.authorization).toBe('Bearer access-secret')
    expect(sent).toEqual([
      {
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        to: 'customer',
        type: nativeType,
        [nativeType]: {
          id: 'generated',
          ...(kind === 'file' ? { filename: fileName } : {})
        }
      }
    ])
    expect((await fixture.storage.getOutbound(turn.deliveryId))?.status).toBe(
      'sent'
    )
  }
)

it('rejects a Graph-provided foreign binary origin before leaking the access token or accepting input', async () => {
  let leaks = 0

  const foreign = await httpPeer((_request, response) => {
    leaks++
    response.end('foreign')
  })

  const graph = await httpPeer((_request, response) => {
    json(response, {
      id: 'original',
      url: `${foreign.base}/binary`,
      mime_type: 'image/png',
      file_size: 3
    })
  })

  const fixture = await mediaRelay(
    createWhatsAppChannel(),
    config(graph.base),
    [{ chatId: 'customer' }],
    ['customer']
  )

  expect(
    (await webhook(fixture.businessUrl, envelope('image', 'image.png'))).status
  ).toBe(500)
  expect(leaks).toBe(0)
  expect(await fixture.storage.listInbound({ limit: 10 })).toEqual([])
})

it.each([
  [429, 'pending'],
  [403, 'rejected'],
  [503, 'pending'],
  [200, 'pending']
] as const)(
  'settles pre-message WhatsApp upload HTTP %s as %s without sending a customer message',
  async (uploadStatus, expected) => {
    let sends = 0

    const graph = await httpPeer((_request, response) => {
      const url = _request.url ?? ''
      if (url.startsWith('/v25.0/original')) {
        json(response, {
          id: 'original',
          url: `${graph.base}/binary`,
          mime_type: 'image/png',
          file_size: 3
        })
      } else if (url === '/binary') {
        response.writeHead(200, { 'Content-Type': 'image/png' })
        response.end(new Uint8Array([1, 2, 3]))
      } else if (url.endsWith('/media')) {
        json(response, {}, uploadStatus)
      } else {
        sends++
        json(response, {
          messaging_product: 'whatsapp',
          messages: [{ id: 'must-not-send' }]
        })
      }
    })

    const fixture = await mediaRelay(
      createWhatsAppChannel(),
      config(graph.base),
      [{ chatId: 'customer' }],
      ['customer']
    )

    expect(
      (await webhook(fixture.businessUrl, envelope('image', 'image.png')))
        .status
    ).toBe(200)
    const record = (await fixture.storage.listInbound({ limit: 10 }))[0]
    if (!record) {
      throw new Error('Expected inbound')
    }
    const turn = await fixture.turn(record.snapshot.requestId)
    await fixture.runtime.processDue()
    expect(sends).toBe(0)
    expect((await fixture.storage.getOutbound(turn.deliveryId))?.status).toBe(
      expected
    )
  }
)
