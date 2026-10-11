import type {
  AccountConfig,
  ChannelHost,
  ChannelPlugin,
  SendInput,
  SendResult,
} from "@relanox/sdk";
import { createRemoteJWKSet, jwtVerify } from "jose";
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
  appId: identifier,
  botId: identifier,
  tenantId: identifier,
  appSecret: secretRef,
  trustedServiceOrigins: z.array(z.url()).min(1),
  issuer: z.string().default("https://api.botframework.com"),
  jwksUrl: z.url().default("https://login.botframework.com/v1/.well-known/keys"),
  tokenUrl: z.url().default("https://login.microsoftonline.com/botframework.com/oauth2/v2.0/token"),
  allowLoopback: z.boolean().default(false),
});
export type TeamsConfig = z.infer<typeof configSchema>;
const identitySchema = z.object({ id: identifier });
const activitySchema = z.object({
  type: z.string(),
  id: identifier.optional(),
  channelId: z.string(),
  serviceUrl: z.url(),
  text: z.string().optional(),
  from: identitySchema,
  recipient: identitySchema,
  conversation: z.object({ id: identifier, tenantId: identifier.optional() }),
  channelData: z.object({ tenant: z.object({ id: identifier }) }),
  replyToId: identifier.optional(),
});
const targetSchema = z.strictObject({
  appId: identifier,
  serviceUrl: z.url(),
  conversationId: identifier,
  tenantId: identifier,
  botId: identifier,
  userId: identifier,
  replyToId: identifier.optional(),
});
const keysSchema = z.object({
  keys: z.array(
    z.object({ kid: identifier.optional(), endorsements: z.array(z.string()).optional() }),
  ),
});
const receiptSchema = z.object({ id: identifier });

function serviceUrl(value: string, config: TeamsConfig): URL {
  const url = endpoint(value, config.allowLoopback);
  if (url.search || !config.trustedServiceOrigins.includes(url.origin)) {
    throw new Error("untrusted_service_origin");
  }
  return url;
}

async function accessToken(config: TeamsConfig, signal: AbortSignal): Promise<string | SendResult> {
  const response = await request(
    endpoint(config.tokenUrl, config.allowLoopback),
    {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "client_credentials",
        client_id: config.appId,
        client_secret: secret(config.appSecret),
        scope: "https://api.botframework.com/.default",
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
  config: TeamsConfig,
  activity: z.infer<typeof activitySchema>,
): Promise<void> {
  if (activity.type !== "message" || !activity.text || activity.from.id === config.botId) {
    host.observe.log("debug", "channel_event_ignored", { errorCode: "unsupported_or_self_text" });
    return;
  }
  if (!activity.id) {
    throw new Error("missing_activity_id");
  }
  const threadId = activity.replyToId;
  await ingest(host, {
    source: {
      channel: "msteams",
      accountId: account.id,
      eventId: `${activity.conversation.id}:${activity.id}`,
    },
    senderId: activity.from.id,
    text: activity.text,
    receivedAt: Date.now(),
    context: { tenantId: config.tenantId },
    target: {
      channel: "msteams",
      accountId: account.id,
      chatId: activity.conversation.id,
      ...(threadId ? { threadId } : {}),
      replyToId: activity.id,
      data: {
        appId: config.appId,
        serviceUrl: activity.serviceUrl,
        conversationId: activity.conversation.id,
        tenantId: config.tenantId,
        botId: config.botId,
        userId: activity.from.id,
        replyToId: threadId ?? activity.id,
      },
    },
  });
}

export function createTeamsChannel(): ChannelPlugin<TeamsConfig> {
  let runtime: { account: AccountConfig; config: TeamsConfig } | undefined;
  async function send(input: SendInput): Promise<SendResult> {
    if (
      !runtime ||
      input.target.accountId !== runtime.account.id ||
      input.target.channel !== "msteams"
    ) {
      return { status: "rejected", errorCode: "invalid_target" };
    }
    const { config } = runtime;
    const parsed = targetSchema.safeParse(input.target.data);
    if (!parsed.success) {
      return { status: "rejected", errorCode: "invalid_target" };
    }
    const target = parsed.data;
    if (
      target.appId !== config.appId ||
      target.conversationId !== input.target.chatId ||
      target.tenantId !== config.tenantId ||
      target.botId !== config.botId
    ) {
      return { status: "rejected", errorCode: "invalid_target" };
    }
    let base: URL;
    try {
      base = serviceUrl(target.serviceUrl, config);
    } catch {
      return { status: "rejected", errorCode: "untrusted_service_origin" };
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
      const suffix = target.replyToId ? `/${encodeURIComponent(target.replyToId)}` : "";
      const url = new URL(
        `${base.href.replace(/\/$/u, "")}/v3/conversations/${encodeURIComponent(target.conversationId)}/activities${suffix}`,
      );
      const response = await request(
        url,
        {
          method: "POST",
          headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
          body: JSON.stringify({
            type: "message",
            text: input.chunk.text,
            channelId: "msteams",
            from: { id: target.botId },
            recipient: { id: target.userId },
            conversation: { id: target.conversationId, tenantId: target.tenantId },
            ...(target.replyToId ? { replyToId: target.replyToId } : {}),
            channelData: { tenant: { id: target.tenantId } },
          }),
        },
        input.signal,
      );
      if (!response.ok) {
        return failure(response);
      }
      return {
        status: "sent",
        receipt: { platformMessageId: receiptSchema.parse(await response.json()).id },
      };
    } catch {
      return unavailable();
    }
  }
  return {
    id: "channel-msteams",
    sdkMajor: 1,
    runtime: "node",
    kind: "channel",
    channel: "msteams",
    capabilities: {
      receive: true,
      transport: "http",
      maxTextLength: 12_000,
      lengthUnit: "utf16",
      idempotentSend: false,
    },
    validateConfig(value) {
      const config = configSchema.parse(value);
      for (const url of [config.tokenUrl, config.jwksUrl, ...config.trustedServiceOrigins]) {
        endpoint(url, config.allowLoopback);
      }
      if (config.trustedServiceOrigins.some((origin) => new URL(origin).origin !== origin)) {
        throw new Error("service_origins_must_be_origins");
      }
      return config;
    },
    async setup(host, account, config) {
      runtime = { account, config };
      const keys = createRemoteJWKSet(endpoint(config.jwksUrl, config.allowLoopback), {
        timeoutDuration: 5000,
        cacheMaxAge: 3_600_000,
      });
      host.mountHttp("/activities", async (incoming) => {
        if (incoming.method !== "POST") {
          return new Response(null, { status: 405 });
        }
        const authorization = incoming.headers.get("authorization");
        if (!authorization?.startsWith("Bearer ")) {
          return new Response(null, { status: 401 });
        }
        const decoded = activitySchema.safeParse(parseBody(await rawBody(incoming)));
        if (!decoded.success) {
          return new Response(null, { status: 400 });
        }
        const activity = decoded.data;
        try {
          const verified = await jwtVerify(authorization.slice(7), keys, {
            algorithms: ["RS256"],
            issuer: config.issuer,
            audience: config.appId,
            requiredClaims: ["exp", "nbf"],
          });
          const jwks = keysSchema.parse(keys.jwks());
          const signingKey = jwks.keys.find((key) => key.kid === verified.protectedHeader.kid);
          if (!signingKey?.endorsements?.includes("msteams")) {
            return new Response(null, { status: 403 });
          }
          if (
            verified.payload.serviceurl !== activity.serviceUrl &&
            verified.payload.serviceUrl !== activity.serviceUrl
          ) {
            return new Response(null, { status: 403 });
          }
          serviceUrl(activity.serviceUrl, config);
        } catch {
          return new Response(null, { status: 401 });
        }
        if (
          activity.channelId !== "msteams" ||
          activity.recipient.id !== config.botId ||
          activity.channelData.tenant.id !== config.tenantId ||
          (activity.conversation.tenantId && activity.conversation.tenantId !== config.tenantId)
        ) {
          return new Response(null, { status: 403 });
        }
        await receive(host, account, config, activity);
        return Response.json({});
      });
    },
    send,
  };
}
