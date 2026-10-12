import { markdownRuns, escapeHtml } from '@relanox/markdown'
import { apiBase } from './constants.js'
import { downloadMedia, mediaKind } from '@relanox/channel-media'
import type { Json, ChannelHost, MediaUpload, SendInput } from '@relanox/sdk'
import type { z } from 'zod'
import { accessToken } from './client.js'
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
    const token = await accessToken(config, signal)
    if (typeof token !== 'string') {
      throw new TypeError('media_oauth_unavailable')
    }
    for (const attachment of message.attachment) {
      const name = attachment.attachmentDataRef?.resourceName
      if (
        !name ||
        !name.startsWith(`${space}/`) ||
        name.includes('..') ||
        /[?#]/u.test(name)
      ) {
        throw new Error('unsupported_attachment_reference')
      }

      const downloaded = await downloadMedia(
        `${apiBase}/v1/media/${name}?alt=media`,
        {
          maxBytes: host.maxMediaBytes ?? 25 * 1024 * 1024,
          signal,
          trustedOrigins: [new URL(apiBase).origin],
          headers: { authorization: `Bearer ${token}` }
        }
      )

      const mimeType = attachment.contentType ?? downloaded.mimeType
      attachments.push({
        ...downloaded,
        mimeType,
        kind: mediaKind(mimeType),
        fileName: attachment.contentName ?? 'attachment.bin'
      })
    }
  }
  return attachments
}

export async function mediaCards(
  input: SendInput,
  host: ChannelHost
): Promise<Json[] | undefined> {
  if (input.chunk.richText) {
    if (!host.media) {
      throw new Error('media_publication_unavailable')
    }
    const widgets: Json[] = []
    for (const part of input.chunk.richText) {
      if (part.type === 'text') {
        widgets.push({
          textParagraph: {
            text: cardText(part.text)
          }
        })
      } else {
        const url = new URL(
          await host.media.publish({
            channelId: input.channelId,
            mediaId: part.media.id
          })
        )

        if (
          url.protocol !== 'https:' ||
          url.username ||
          url.password ||
          url.hash
        ) {
          throw new Error('invalid_publication_url')
        }
        widgets.push({
          image: {
            imageUrl: url.href,
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
      if (run.code || run.pre) {
        text = `<code>${text}</code>`
      }
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
