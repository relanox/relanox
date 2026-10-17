import { installPeerNetwork } from '../../channel-wecom/tests/network.js'
import { assemble } from '../../channel-wecom/tests/test-support.js'
import { afterEach, expect, it } from 'vitest'
import { z } from 'zod'
import { createFeishuChannel } from '../src/index.js'
import { installSdkNetwork, peer } from './peer.js'

installPeerNetwork()
installSdkNetwork()
const cleanup: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const close of cleanup.splice(0).toReversed()) {
    await close()
  }
})

// Protect Core's persisted rich layout before SDK upload, not only plugin.send.
// A 10MiB/MIME descriptor or repeated preflight used to force a standalone file
// Or reject it; existing rich peers use five-byte PNGs. Real SQLite/HTTP and the
// Published SDK are used, with no production seam. Bytes are opaque test data;
// The peer's response models platform acceptance, not real-account AVIF support.
// SDK 1.75.0 MediaUploader.uploadImage uses im.v1.image.create; the post shape is
// https://open.feishu.cn/document/server-docs/im-v1/message-content-description/message_content
it('keeps a budgeted large image in Core rich layout and delegates acceptance to the SDK', async () => {
  const remote = await peer((input) => {
    if (input.path.includes('tenant_access_token')) {
      return { body: { code: 0, tenant_access_token: 'token', expire: 7200 } }
    }
    return {
      body: input.path.endsWith('/images')
        ? { code: 0, data: { image_key: 'img_large' } }
        : { code: 0, data: { message_id: 'om_sent' } }
    }
  })

  cleanup.push(remote.close)

  const local = await assemble(
    createFeishuChannel({ APP: 'secret', ENCRYPT: 'key', VERIFY: 'token' }),
    {
      appId: 'cli_app',
      appSecret: { env: 'APP' },
      encryptKey: { env: 'ENCRYPT' },
      verificationToken: { env: 'VERIFY' },
      tenantKey: 'tenant-1'
    },
    [{ chatId: 'oc_chat', senderId: 'ou_user' }]
  )

  const principal = local.principal()
  const channel = (await principal.status()).channels[0]?.channel.id
  if (!channel) {
    throw new Error('missing_channel')
  }

  const queued = await principal.sendMessage({
    channel,
    text: `${'a'.repeat(8001)}\n![photo](relanox://attachment/1)\nafter`,
    attachments: [
      {
        kind: 'image',
        mimeType: 'image/avif',
        fileName: 'large.avif',
        data: new Uint8Array(10 * 1024 * 1024 + 1)
      }
    ]
  })

  expect(queued.status).toBe('queued')
  if (queued.status !== 'queued') {
    throw new Error('missing_delivery')
  }
  const plan = await local.storage.getOutbound(queued.deliveryId)
  expect(plan?.chunks).toHaveLength(2)
  expect(plan?.chunks[1]?.richText?.map((part) => part.type)).toEqual([
    'text',
    'image',
    'text'
  ])
  await local.runtime.processDue()
  await local.runtime.processDue()
  expect((await local.storage.getOutbound(queued.deliveryId))?.status).toBe(
    'sent'
  )

  const sent = remote.requests.filter((item) =>
    item.path.startsWith('/open-apis/im/v1/messages?')
  )

  expect(sent).toHaveLength(2)
  const body = z.object({ content: z.string() }).parse(sent[1]?.body)
  expect(JSON.parse(body.content)).toMatchObject({
    zh_cn: {
      content: [
        [{ tag: 'md' }],
        [{ tag: 'img', image_key: 'img_large' }],
        [{ tag: 'md', text: '\nafter' }]
      ]
    }
  })
  expect(
    remote.requests.filter((item) => item.path.endsWith('/images'))
  ).toHaveLength(1)
})
