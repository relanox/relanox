import { markdownRuns, escapeHtml } from '@relanox/markdown'
import { mediaKind, MediaDownloadError } from '@relanox/channel-media'
import { Readable } from 'node:stream'
import type { ChannelHost, MediaUpload, SendInput } from '@relanox/sdk'
import type { chat_v1 } from '@googleapis/chat'
import type { z } from 'zod'
import { chatClient, rejectMediaToken } from './sdk.js'
import type { GoogleChatConfig } from './config.js'
import type { eventSchema } from './schemas.js'

type Message = NonNullable<z.infer<typeof eventSchema>['message']>

export async function downloadAttachments(
  message: Message,
  space: string,
  config: GoogleChatConfig,
  host: ChannelHost
): Promise<MediaUpload[]> {
  const attachments = []
  if (message.attachment?.length) {
    const signal = AbortSignal.timeout(120_000)
    for (const attachment of message.attachment) {
      const name = attachment.attachmentDataRef?.resourceName
      if (
        !name ||
        !name.startsWith(`${space}/`) ||
        name.includes('..') ||
        /[\\%?#]/u.test(name)
      ) {
        throw new Error('unsupported_attachment_reference')
      }

      const response = await chatClient(config).media.download(
        { resourceName: name, alt: 'media' },
        {
          responseType: 'stream',
          signal,
          // Gaxios otherwise buffers failed stream responses without a bound.
          // The SDK fixes the Google origin; redirects remain disabled above.
          validateStatus: () => true
        }
      )

      const stream = Readable.from(response.data)
      let data: Uint8Array
      try {
        rejectMediaToken(config, response.status)
        if (!response.ok) {
          throw new MediaDownloadError('media_download_failed', response.status)
        }
        data = await readMedia(
          stream,
          response.headers['content-length'] ?? '',
          host.maxMediaBytes ?? 100 * 1024 * 1024
        )
      } finally {
        stream.destroy()
      }

      const mimeType =
        attachment.contentType ??
        (response.headers['content-type'] ?? 'application/octet-stream')
          .split(';')[0]
          ?.trim() ??
        'application/octet-stream'

      attachments.push({
        data,
        mimeType,
        kind: mediaKind(mimeType),
        fileName: attachment.contentName ?? 'attachment.bin'
      })
    }
  }
  return attachments
}

/** Bound actual SDK stream bytes even when the server omits Content-Length. */
async function readMedia(
  stream: Readable,
  declared: string,
  maximum: number
): Promise<Uint8Array> {
  if (Number(declared) > maximum) {
    throw new MediaDownloadError('media_too_large')
  }
  const chunks: Uint8Array[] = []
  let size = 0
  for await (const part of stream) {
    const bytes = part as Uint8Array
    size += bytes.byteLength
    if (size > maximum) {
      throw new MediaDownloadError('media_too_large')
    }
    chunks.push(bytes)
  }
  return Buffer.concat(chunks, size)
}

export async function mediaCards(
  input: SendInput,
  host: ChannelHost
): Promise<chat_v1.Schema$CardWithId[] | undefined> {
  if (input.chunk.richText) {
    if (!host.media) {
      throw new Error('media_publication_unavailable')
    }
    const widgets: chat_v1.Schema$GoogleAppsCardV1Widget[] = []
    for (const part of input.chunk.richText) {
      if (part.type === 'text') {
        widgets.push({
          textParagraph: {
            text: cardText(part.text)
          }
        })
      } else {
        const url = await host.media.publish({
          channelId: input.channelId,
          mediaId: part.media.id
        })

        widgets.push({
          image: {
            imageUrl: url,
            altText: part.label || part.media.fileName
          }
        })
      }
    }

    const cards = [
      { cardId: input.chunk.idempotencyKey, card: { sections: [{ widgets }] } }
    ]

    if (Buffer.byteLength(JSON.stringify(cards), 'utf8') > 24_000) {
      throw new Error('rich_text_limit_exceeded')
    }
    return cards
  }
  let cardsV2
  if (input.chunk.media) {
    if (!input.media || !host.media) {
      throw new Error('media_publication_unavailable')
    }

    const url = await host.media.publish({
      channelId: input.channelId,
      mediaId: input.media.reference.id
    })

    const { kind, fileName } = input.media.reference
    cardsV2 = [
      {
        cardId: input.chunk.idempotencyKey,
        card: {
          sections: [
            {
              widgets: [
                ...(kind === 'image'
                  ? [{ image: { imageUrl: url, altText: fileName } }]
                  : []),
                {
                  buttonList: {
                    buttons: [
                      { text: fileName, onClick: { openLink: { url } } }
                    ]
                  }
                }
              ]
            }
          ]
        }
      }
    ]
  }
  return cardsV2
}

function cardText(markdown: string): string {
  return markdownRuns(markdown)
    .map((run) => {
      let text = escapeHtml(run.text).replaceAll('\n', '<br>')
      if (run.bold) {
        text = `<b>${text}</b>`
      }
      if (run.italic) {
        text = `<i>${text}</i>`
      }
      if (run.strikethrough) {
        text = `<s>${text}</s>`
      }
      if (run.href) {
        text = `<a href="${escapeHtml(run.href)}">${text}</a>`
      }
      return text
    })
    .join('')
}
