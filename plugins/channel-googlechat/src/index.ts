import type {
  AccountConfig,
  ChannelHost,
  ChannelPlugin,
  SendInput,
  SendResult,
} from "@relanox/sdk";
import { createRemoteJWKSet, importPKCS8, jwtVerify, SignJWT } from "jose";
import { z } from "zod";
import {
  endpoint,
  failure,
  identifier,
  ingest,
  oauthResponse,
  parseBody,
  rawBody,
  request,
  secret,
  secretRef,
  unavailable,
} from "./io.js";

const configSchema = z.strictObject({
  audience: identifier,
  callerEmail: z.email().default("chat@system.gserviceaccount.com"),
  issuer: z.string().default("https://accounts.google.com"),
  jwksUrl: z.url().default("https://www.googleapis.com/oauth2/v3/certs"),
  serviceAccount: secretRef,
  apiBase: z.url().default("https://chat.googleapis.com"),
  tokenUrl: z.url().default("https://oauth2.googleapis.com/token"),
  allowLoopback: z.boolean().default(false),
});
export type GoogleChatConfig = z.infer<typeof configSchema>;
const serviceSchema = z.object({
  type: z.literal("service_account"),
  client_email: z.email(),
  private_key: z.string().min(1).max(16_384),
});
const spaceId = z.string().regex(/^spaces\/[A-Za-z0-9_-]+$/u);
const threadId = z.string().regex(/^spaces\/[A-Za-z0-9_-]+\/threads\/[A-Za-z0-9_-]+$/u);
const messageSchema = z.object({
  name: identifier,
  text: z.string().optional(),
  argumentText: z.string().optional(),
  sender: z.object({ name: identifier, type: z.string().optional() }),
  thread: z.object({ name: threadId }).optional(),
});
const eventSchema = z.object({
  type: z.string(),
  space: z.object({ name: spaceId }).optional(),
  message: messageSchema.optional(),
});
const targetSchema = z.strictObject({
  space: spaceId,
  thread: threadId.optional(),
  scope: z.strictObject({ clientEmail: z.email(), apiBase: z.url() }),
});
const receiptSchema = z.object({ name: identifier });

async function accessToken(
  config: GoogleChatConfig,
  signal: AbortSignal,
): Promise<string | SendResult> {
  const service = serviceSchema.parse(JSON.parse(secret(config.serviceAccount)) as unknown);
  const key = await importPKCS8(service.private_key, "RS256");
  const assertion = await new SignJWT({ scope: "https://www.googleapis.com/auth/chat.bot" })
    .setProtectedHeader({ alg: "RS256" })
    .setIssuer(service.client_email)
    .setAudience(config.tokenUrl)
    .setIssuedAt()
    .setExpirationTime("1h")
    .sign(key);
  const response = await request(
    endpoint(config.tokenUrl, config.allowLoopback),
    {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
        assertion,
      }),
    },
    signal,
  );
  if (!response.ok) {
    return response.status >= 500
      ? { status: "retryable", errorCode: "oauth_unavailable" }
      : failure(response);
  }
  return oauthResponse.parse(await response.json()).access_token;
}

async function receive(
  host: ChannelHost,
  account: AccountConfig,
  event: z.infer<typeof eventSchema>,
  config: GoogleChatConfig,
): Promise<void> {
  const { space, message } = event;
  if (event.type !== "MESSAGE" || !space || !message || message.sender.type === "BOT") {
    host.observe.log("debug", "channel_event_ignored", { errorCode: "unsupported_or_self_text" });
    return;
  }
  const text = message.argumentText ?? message.text;
  if (!text) {
    host.observe.log("debug", "channel_event_ignored", { errorCode: "unsupported_or_self_text" });
    return;
  }
  if (
    !message.name.startsWith(`${space.name}/messages/`) ||
    (message.thread && !message.thread.name.startsWith(`${space.name}/threads/`))
  ) {
    throw new Error("inconsistent_space");
  }
  const target = {
    channel: "googlechat" as const,
    accountId: account.id,
    chatId: space.name,
    ...(message.thread ? { threadId: message.thread.name } : {}),
    replyToId: message.name,
    data: {
      space: space.name,
      ...(message.thread ? { thread: message.thread.name } : {}),
      scope: {
        clientEmail: serviceSchema.parse(JSON.parse(secret(config.serviceAccount)) as unknown)
          .client_email,
        apiBase: new URL(config.apiBase).href,
      },
    },
  };
  await ingest(host, {
    source: { channel: "googlechat", accountId: account.id, eventId: message.name },
    senderId: message.sender.name,
    text,
    target,
    receivedAt: Date.now(),
    context: null,
  });
}

export function createGoogleChatChannel(): ChannelPlugin<GoogleChatConfig> {
  let runtime: { account: AccountConfig; config: GoogleChatConfig } | undefined;
  async function send(input: SendInput): Promise<SendResult> {
    if (
      !runtime ||
      input.target.accountId !== runtime.account.id ||
      input.target.channel !== "googlechat"
    ) {
      return { status: "rejected", errorCode: "invalid_target" };
    }
    const { config } = runtime;
    const parsed = targetSchema.safeParse(input.target.data);
    if (!parsed.success) {
      return { status: "rejected", errorCode: "invalid_target" };
    }
    const target = parsed.data;
    if (target.space !== input.target.chatId || target.thread !== input.target.threadId) {
      return { status: "rejected", errorCode: "invalid_target" };
    }
    let clientEmail: string;
    try {
      clientEmail = serviceSchema.parse(
        JSON.parse(secret(config.serviceAccount)) as unknown,
      ).client_email;
    } catch {
      return { status: "retryable", errorCode: "oauth_unavailable" };
    }
    if (
      target.scope.clientEmail !== clientEmail ||
      target.scope.apiBase !== new URL(config.apiBase).href
    ) {
      return { status: "rejected", errorCode: "target_identity_changed" };
    }
    let token: string | SendResult;
    try {
      token = await accessToken(config, input.signal);
    } catch {
      return { status: "retryable", errorCode: "oauth_unavailable" };
    }
    if (typeof token !== "string") {
      return token;
    }
    try {
      const url = endpoint(`${config.apiBase}/v1/${target.space}/messages`, config.allowLoopback);
      if (target.thread) {
        url.searchParams.set("messageReplyOption", "REPLY_MESSAGE_OR_FAIL");
      }
      const response = await request(
        url,
        {
          method: "POST",
          headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
          body: JSON.stringify({
            text: input.chunk.text,
            ...(target.thread ? { thread: { name: target.thread } } : {}),
          }),
        },
        input.signal,
      );
      if (!response.ok) {
        return failure(response);
      }
      return {
        status: "sent",
        receipt: { platformMessageId: receiptSchema.parse(await response.json()).name },
      };
    } catch {
      return unavailable();
    }
  }
  return {
    id: "channel-googlechat",
    sdkMajor: 1,
    runtime: "node",
    kind: "channel",
    channel: "googlechat",
    capabilities: {
      receive: true,
      transport: "http",
      maxTextLength: 30_000,
      lengthUnit: "utf8",
      idempotentSend: false,
    },
    validateConfig(value) {
      const config = configSchema.parse(value);
      for (const url of [config.apiBase, config.tokenUrl, config.jwksUrl]) {
        endpoint(url, config.allowLoopback);
      }
      return config;
    },
    async setup(host, account, config) {
      runtime = { account, config };
      const keys = createRemoteJWKSet(endpoint(config.jwksUrl, config.allowLoopback), {
        timeoutDuration: 5000,
        cacheMaxAge: 3_600_000,
      });
      host.mountHttp("/webhook", async (incoming) => {
        if (incoming.method !== "POST") {
          return new Response(null, { status: 405 });
        }
        const authorization = incoming.headers.get("authorization");
        if (!authorization?.startsWith("Bearer ")) {
          return new Response(null, { status: 401 });
        }
        try {
          const { payload } = await jwtVerify(authorization.slice(7), keys, {
            algorithms: ["RS256"],
            issuer: config.issuer,
            audience: config.audience,
            requiredClaims: ["exp", "iat", "email", "email_verified"],
          });
          if (payload.email !== config.callerEmail || payload.email_verified !== true) {
            return new Response(null, { status: 401 });
          }
        } catch {
          return new Response(null, { status: 401 });
        }
        const event = eventSchema.safeParse(parseBody(await rawBody(incoming)));
        if (!event.success) {
          return new Response(null, { status: 400 });
        }
        await receive(host, account, event.data, config);
        return Response.json({});
      });
    },
    send,
  };
}
