import { receiveParts, mediaMessage, uploadFailure } from "./media.js";
import type {
  AccountConfig,
  ChannelHost,
  ChannelPlugin,
  SendInput,
  SendResult,
} from "@relanox/sdk";
import type { z } from "zod";
import { configSchema, validateTransportUrl } from "./config.js";
import type { DingTalkConfig } from "./config.js";
import {
  streamOpenResponseSchema,
  streamSchema,
  messageSchema,
  tokenSchema,
  targetSchema,
  sendResponse,
} from "./schemas.js";
import type { scopeSchema } from "./schemas.js";
import {
  JsonSocketConnection,
  httpJson,
  ingestText,
  jsonPostRequest,
  RemoteError,
  secret,
  sendFailure,
} from "./transport.js";

const topic = "/v1.0/im/bot/messages/get";

function matchesScope(
  scope: z.infer<typeof scopeSchema>,
  config: DingTalkConfig,
  media = false,
): boolean {
  return (
    scope.clientId === config.clientId &&
    scope.robotCode === config.robotCode &&
    scope.apiBase === new URL(config.apiBase).href &&
    (!media || scope.uploadBase === new URL(config.uploadBase).href)
  );
}

export function createDingTalkChannel(): ChannelPlugin<DingTalkConfig> {
  let host: ChannelHost;
  let account: AccountConfig;
  let config: DingTalkConfig;
  let connection: JsonSocketConnection;
  let token: { value: string; expiresAt: number; credential: string } | undefined;
  let tokenFlight: Promise<string> | undefined;
  const api = (path: string) => `${config.apiBase.replace(/\/$/u, "")}${path}`;
  async function getAccessToken(signal: AbortSignal): Promise<string> {
    const credential = secret(config.clientSecret);
    if (token && token.credential === credential && token.expiresAt > Date.now()) {
      return token.value;
    }
    if (tokenFlight) {
      return tokenFlight;
    }
    tokenFlight = (async () => {
      const body = tokenSchema.parse(
        await httpJson(
          api("/v1.0/oauth2/accessToken"),
          jsonPostRequest({ appKey: config.clientId, appSecret: credential }),
          signal,
        ),
      );
      token = {
        value: body.accessToken,
        credential,
        expiresAt: Date.now() + Math.max(1, body.expireIn - 60) * 1000,
      };
      return token.value;
    })();
    try {
      return await tokenFlight;
    } finally {
      tokenFlight = undefined;
    }
  }
  async function receive(raw: unknown): Promise<void> {
    const frame = streamSchema.parse(raw);
    const ack = (code: number, data: string) => {
      connection.send({
        code,
        headers: {
          contentType: "application/json",
          messageId: frame.headers.messageId,
        },
        message: code === 200 ? "OK" : "Unsupported",
        data,
      });
    };
    if (frame.type === "SYSTEM") {
      if (frame.headers.topic === "ping") {
        ack(200, frame.data);
      }
      if (frame.headers.topic === "disconnect") {
        connection.socket?.close();
      }
      return;
    }
    if (frame.type !== "CALLBACK" || frame.headers.topic !== topic || !frame.headers.messageId) {
      return;
    }
    const message = messageSchema.parse(JSON.parse(frame.data));
    if (
      message.robotCode !== config.robotCode ||
      message.senderId === message.chatbotUserId ||
      (message.conversationType === "2" && message.isInAtList !== true)
    ) {
      ack(200, '{"response":null}');
      return;
    }
    if (
      !["text", "picture", "audio", "video", "file", "richText"].includes(message.msgtype) ||
      (message.msgtype !== "text" && !message.content)
    ) {
      host.observe.log("info", "channel_unsupported_input", {
        errorCode: "unsupported_message_type",
      });
      ack(404, '{"response":null}');
      return;
    }
    if (!message.senderStaffId) {
      ack(404, '{"response":null}');
      host.observe.log("warn", "channel_unsupported_sender", {
        errorCode: "missing_staff_id",
      });
      return;
    }
    const credential =
      message.msgtype === "text" ? undefined : await getAccessToken(connection.signal);
    const { text, attachments } = await receiveParts(
      message,
      config,
      host,
      credential,
      connection.signal,
    );
    const scope = {
      clientId: config.clientId,
      robotCode: config.robotCode,
      apiBase: new URL(config.apiBase).href,
      uploadBase: new URL(config.uploadBase).href,
    };
    const group = message.conversationType === "2";
    const chatId = group ? message.conversationId : message.senderStaffId;
    await ingestText(host, {
      source: {
        channel: "dingtalk",
        accountId: account.id,
        eventId: message.msgId,
      },
      senderId: message.senderId,
      text,
      attachments,
      target: {
        channel: "dingtalk",
        accountId: account.id,
        chatId,
        replyToId: message.msgId,
        data: group
          ? { type: "group", openConversationId: message.conversationId, scope }
          : { type: "single", staffId: message.senderStaffId, scope },
      },
      receivedAt: Date.now(),
      context: null,
    });
    ack(200, '{"response":null}');
  }
  return {
    id: "channel-dingtalk",
    sdkMajor: 1,
    runtime: "node",
    kind: "channel",
    channel: "dingtalk",
    capabilities: {
      receive: true,
      transport: "connection",
      maxTextLength: 4000,
      lengthUnit: "utf8",
      idempotentSend: false,
      media: {
        receive: ["image", "audio", "video", "file"],
        send: ["image", "audio", "video", "file"],
      },
    },
    validateConfig: (value) => configSchema.parse(value),
    async setup(nextHost, nextAccount, nextConfig) {
      host = nextHost;
      account = nextAccount;
      config = configSchema.parse(nextConfig);
      connection = new JsonSocketConnection(
        host,
        async (signal) => {
          const body = streamOpenResponseSchema.parse(
            await httpJson(
              api("/v1.0/gateway/connections/open"),
              jsonPostRequest({
                clientId: config.clientId,
                clientSecret: secret(config.clientSecret),
                ua: "relanox-node/0.1.0",
                subscriptions: [{ type: "CALLBACK", topic }],
              }),
              signal,
            ),
          );
          const url = new URL(
            validateTransportUrl(body.endpoint, true, config.allowInsecureLoopback),
          );
          url.searchParams.set("ticket", body.ticket);
          return url.toString();
        },
        async () => {
          connection.ready();
          let alive = true;
          connection.socket?.on("pong", () => {
            alive = true;
          });
          connection.setHeartbeat(30_000, () => {
            if (!alive) {
              connection.socket?.terminate();
            } else {
              alive = false;
              connection.socket?.ping();
            }
          });
        },
        receive,
        () => {},
        config.maxReconnectAttempts,
      );
    },
    start: (signal) => connection.start(signal),
    stop: () => connection.stop(),
    async send(input: SendInput): Promise<SendResult> {
      const target = targetSchema.safeParse(input.target.data);
      if (
        input.target.channel !== "dingtalk" ||
        input.target.accountId !== account.id ||
        !target.success
      ) {
        return { status: "rejected", errorCode: "invalid_target" };
      }
      const data = target.data;
      if (!matchesScope(data.scope, config, input.chunk.media !== undefined)) {
        return { status: "rejected", errorCode: "target_identity_changed" };
      }
      if (
        input.target.chatId !== (data.type === "group" ? data.openConversationId : data.staffId)
      ) {
        return { status: "rejected", errorCode: "invalid_target" };
      }
      let credential: string;
      try {
        credential = await getAccessToken(input.signal);
      } catch (error) {
        if (error instanceof RemoteError && error.result.status !== "unknown") {
          return error.result;
        }
        return { status: "retryable", errorCode: "token_unavailable" };
      }
      let transmitting = false;
      try {
        const payload = await mediaMessage(input, config, credential);
        transmitting = true;
        const body = sendResponse.parse(
          await httpJson(
            api(
              data.type === "group"
                ? "/v1.0/robot/groupMessages/send"
                : "/v1.0/robot/oToMessages/batchSend",
            ),
            jsonPostRequest(
              {
                robotCode: config.robotCode,
                ...(data.type === "group"
                  ? { openConversationId: data.openConversationId }
                  : { userIds: [data.staffId] }),
                ...payload,
              },
              { "x-acs-dingtalk-access-token": credential },
            ),
            input.signal,
          ),
        );
        if (body.invalidStaffIdList?.length) {
          return { status: "rejected", errorCode: "invalid_staff_id" };
        }
        if (body.flowControlledStaffIdList?.length) {
          return {
            status: "retryable",
            errorCode: "staff_rate_limited",
            retryAfterMs: 1000,
          };
        }
        return {
          status: "sent",
          receipt: { data: { processQueryKey: body.processQueryKey } },
        };
      } catch (error) {
        if (error instanceof RemoteError && error.result.errorCode === "http_401") {
          token = undefined;
          return {
            status: "retryable",
            errorCode: "token_expired",
            retryAfterMs: 1000,
          };
        }
        return transmitting ? sendFailure(error) : uploadFailure(error);
      }
    },
  };
}
