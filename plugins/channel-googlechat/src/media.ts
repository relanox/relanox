import { downloadMedia, mediaKind } from "@relanox/media";
import type { ChannelHost, MediaUpload, SendInput } from "@relanox/sdk";
import type { z } from "zod";
import { accessToken } from "./client.js";
import type { GoogleChatConfig } from "./config.js";
import type { eventSchema } from "./schemas.js";

type Message = NonNullable<z.infer<typeof eventSchema>["message"]>;

export async function downloadAttachments(
  message: Message,
  space: string,
  config: GoogleChatConfig,
  host: ChannelHost,
): Promise<MediaUpload[]> {
  const attachments = [];
  if (message.attachment?.length) {
    const signal = AbortSignal.timeout(120_000);
    const token = await accessToken(config, signal);
    if (typeof token !== "string") {
      throw new TypeError("media_oauth_unavailable");
    }
    for (const attachment of message.attachment) {
      const name = attachment.attachmentDataRef?.resourceName;
      if (!name || !name.startsWith(`${space}/`) || name.includes("..") || /[?#]/u.test(name)) {
        throw new Error("unsupported_attachment_reference");
      }

      const downloaded = await downloadMedia(`${config.apiBase}/v1/media/${name}?alt=media`, {
        maxBytes: host.maxMediaBytes ?? 25 * 1024 * 1024,
        signal,
        trustedOrigins: [new URL(config.apiBase).origin],
        allowInsecureLocalhost: config.allowLoopback,
        headers: { authorization: `Bearer ${token}` },
      });

      const mimeType = attachment.contentType ?? downloaded.mimeType;
      attachments.push({
        ...downloaded,
        mimeType,
        kind: mediaKind(mimeType),
        fileName: attachment.contentName ?? "attachment.bin",
      });
    }
  }
  return attachments;
}

export async function mediaCards(input: SendInput, host: ChannelHost) {
  let cardsV2;
  if (input.chunk.media) {
    if (!input.media || !host.media) {
      throw new Error("media_publication_unavailable");
    }

    const url = await host.media.publish({
      requestId: input.requestId,
      mediaId: input.media.reference.id,
    });

    const { kind, fileName } = input.media.reference;
    cardsV2 = [
      {
        cardId: input.chunk.idempotencyKey,
        card: {
          sections: [
            {
              widgets: [
                ...(kind === "image" ? [{ image: { imageUrl: url, altText: fileName } }] : []),
                {
                  buttonList: { buttons: [{ text: fileName, onClick: { openLink: { url } } }] },
                },
              ],
            },
          ],
        },
      },
    ];
  }
  return cardsV2;
}
