import { expect, it } from 'vitest'
import { createMatrixChannel } from '../src/index.js'
import { body, httpPeer, json } from './harness.js'
import { richHost, richInput } from './rich-fixture.js'

it('uploads inline images and sends one ordered Matrix HTML event with a stable transaction', async () => {
  const sent: {
    path: string
    content: unknown
    authorization: string | undefined
  }[] = []

  const uploaded: Buffer[] = []

  const peer = await httpPeer(async (request, response) => {
    if (request.url?.includes('/state/')) {
      // Missing room encryption state: Matrix Client-Server v1.15 state endpoint.
      // https://spec.matrix.org/v1.15/client-server-api/#get_matrixclientv3roomsroomidstateeventtypestatekey
      json(response, { errcode: 'M_NOT_FOUND' }, 404)
    } else if (request.url?.includes('/upload')) {
      const chunks: Buffer[] = []
      for await (const bytes of request) {
        chunks.push(Buffer.from(bytes as Uint8Array))
      }
      uploaded.push(Buffer.concat(chunks))
      json(response, { content_uri: 'mxc://server.example/chart' })
    } else {
      sent.push({
        path: request.url ?? '',
        content: await body(request),
        authorization: request.headers.authorization
      })
      json(response, { event_id: '$rich' })
    }
  })

  const plugin = createMatrixChannel({ TOKEN: 'secret' })
  const { host } = await richHost(false)
  await plugin.setup(
    host,
    { id: 'account', channel: 'matrix', config: null, allowedSenders: [] },
    plugin.validateConfig({
      homeserver: peer.base,
      accessToken: { env: 'TOKEN' },
      allowInsecureLocalhost: true
    })
  )

  const input = richInput({
    channel: 'matrix',
    accountId: 'account',
    chatId: '!room:example',
    threadId: '$thread',
    data: { homeserver: peer.base, userId: '@bot:local.test' }
  })

  expect(await plugin.send(input)).toEqual({
    status: 'sent',
    receipt: { platformMessageId: '$rich' }
  })
  expect(uploaded).toEqual([Buffer.from([9, 8, 7])])
  expect(sent).toEqual([
    {
      path: '/_matrix/client/v3/rooms/!room%3Aexample/send/m.room.message/durable-rich%3A0',
      authorization: 'Bearer secret',
      content: {
        msgtype: 'm.text',
        body: 'Before\n\nChart ] <unsafe>\n\nAfter',
        format: 'org.matrix.custom.html',
        formatted_body:
          '<p><strong>Before</strong></p>\n<img src="mxc://server.example/chart" alt="Chart ] &lt;unsafe&gt;"><p><em>After</em></p>\n',
        'm.relates_to': {
          rel_type: 'm.thread',
          event_id: '$thread'
        }
      }
    }
  ])
  expect(await plugin.send({ ...input, richMedia: [] })).toMatchObject({
    status: 'rejected',
    errorCode: 'missing_media'
  })
  expect(sent).toHaveLength(1)
  expect(uploaded).toHaveLength(1)
})
