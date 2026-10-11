import type { Client } from '@modelcontextprotocol/client'
import { z } from 'zod'
import type { mediaPeer } from './media-peer.js'

export const mediaRequestSchema = z.looseObject({
  replyTo: z.string(),
  text: z.string(),
  attachments: z.array(
    z.looseObject({
      id: z.string(),
      kind: z.string(),
      mimeType: z.string(),
      fileName: z.string(),
      size: z.number()
    })
  )
})

export async function dispatchedMedia(
  routine: Awaited<ReturnType<typeof mediaPeer>>
): Promise<z.infer<typeof mediaRequestSchema>> {
  const notification = z
    .object({ content: z.string() })
    .parse(
      JSON.parse(
        Buffer.from(routine.traffic[0]?.data ?? []).toString()
      ) as unknown
    )

  return mediaRequestSchema.parse(JSON.parse(notification.content) as unknown)
}

export async function readMedia(
  client: Client,
  replyTo: string,
  mediaId: string
): Promise<Uint8Array<ArrayBuffer>> {
  const result = await client.callTool({
    name: 'relanox_read_media',
    arguments: { replyTo, mediaId }
  })

  const contents = z
    .array(
      z.union([
        z.object({ type: z.enum(['image', 'audio']), data: z.string() }),
        z.object({ type: z.literal('resource_link'), uri: z.url() }),
        z.object({ type: z.literal('text'), text: z.string() })
      ])
    )
    .parse(result.content)

  const content = contents[0]
  if (!content || content.type === 'text') {
    throw new Error('missing_media_content')
  }
  if (content.type === 'resource_link') {
    const response = await fetch(content.uri)
    if (!response.ok) {
      throw new Error('media_download_failed')
    }
    return new Uint8Array(await response.arrayBuffer())
  }
  return new Uint8Array(Buffer.from(content.data, 'base64'))
}
