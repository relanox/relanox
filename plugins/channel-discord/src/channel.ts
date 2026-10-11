import { createHash } from "node:crypto";
import type { AccountConfig, ChannelHost, ChannelPlugin } from "@relanox/sdk";
import { z } from "zod";
import { validateConfig } from "./config.js";
import type { DiscordConfig } from "./config.js";
import { createDiscordGateway } from "./gateway.js";
import { targetSchema } from "./schemas.js";
import { credential, failure, id, jsonResponse, post } from "./transport.js";

export function createDiscordChannel(
  environment: NodeJS.ProcessEnv = process.env,
): ChannelPlugin<DiscordConfig> {
  let config: DiscordConfig;
  let host: ChannelHost;
  let account: AccountConfig;
  let gateway: ReturnType<typeof createDiscordGateway>;
  const identity = () => ({
    botId: config.botUserId,
    apiBaseUrl: new URL(config.apiBaseUrl).toString().replace(/\/$/u, ""),
  });
  return {
    id: "channel-discord",
    sdkMajor: 1,
    runtime: "node",
    kind: "channel",
    channel: "discord",
    capabilities: {
      receive: true,
      transport: "connection",
      maxTextLength: 2000,
      lengthUnit: "utf16",
      idempotentSend: false,
    },
    validateConfig,
    async setup(nextHost, nextAccount, nextConfig) {
      host = nextHost;
      account = nextAccount;
      config = nextConfig;
      credential(config.botToken, environment);
      gateway = createDiscordGateway(config, host, account, environment);
    },
    async start(signal) {
      await gateway.start(signal);
    },
    async stop() {
      await gateway.stop();
    },
    async send(input) {
      const data = targetSchema.safeParse(input.target.data);
      const current = identity();
      if (
        !data.success ||
        data.data.botId !== current.botId ||
        data.data.apiBaseUrl !== current.apiBaseUrl ||
        input.target.channel !== "discord" ||
        input.target.accountId !== account.id ||
        !/^\d+$/u.test(input.target.chatId) ||
        (input.target.threadId && !/^\d+$/u.test(input.target.threadId)) ||
        (input.target.replyToId && !/^\d+$/u.test(input.target.replyToId))
      ) {
        return { status: "rejected", errorCode: "invalid_target" };
      }
      try {
        const response = await post(
          `${config.apiBaseUrl.replace(/\/$/u, "")}/channels/${input.target.threadId ?? input.target.chatId}/messages`,
          { authorization: `Bot ${credential(config.botToken, environment)}` },
          {
            content: input.chunk.text,
            allowed_mentions: { parse: [], replied_user: false },
            nonce: createHash("sha256")
              .update(input.chunk.idempotencyKey)
              .digest("hex")
              .slice(0, 24),
            enforce_nonce: true,
            ...(input.target.replyToId
              ? {
                  message_reference: {
                    message_id: input.target.replyToId,
                    fail_if_not_exists: false,
                  },
                }
              : {}),
          },
          input.signal,
          config.timeoutMs,
        );
        if (response.status === 429) {
          const parsed = z
            .looseObject({ retry_after: z.number().nonnegative() })
            .safeParse(await jsonResponse(response).catch(() => null));
          return {
            status: "retryable",
            errorCode: "rate_limited",
            ...(parsed.success ? { retryAfterMs: Math.ceil(parsed.data.retry_after * 1000) } : {}),
          };
        }
        if (!response.ok) {
          return failure(response);
        }
        const parsed = z.looseObject({ id }).safeParse(await jsonResponse(response));
        return parsed.success
          ? { status: "sent", receipt: { platformMessageId: parsed.data.id } }
          : { status: "unknown", errorCode: "invalid_platform_response" };
      } catch {
        return { status: "unknown", errorCode: "discord_transport_error" };
      }
    },
  };
}
