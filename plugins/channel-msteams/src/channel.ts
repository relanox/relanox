import type { AccountConfig, ChannelPlugin, SendInput, SendResult } from "@relanox/sdk";
import { createRemoteJWKSet, jwtVerify } from "jose";
import { accessToken, serviceUrl } from "./client.js";
import { validateConfig, validateEndpointUrl } from "./config.js";
import type { TeamsConfig } from "./config.js";
import { receive } from "./inbound.js";
import { failure, parseBody, rawBody, request, unavailable } from "./io.js";
import { activitySchema, targetSchema, keysSchema, receiptSchema } from "./schemas.js";

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
    validateConfig,
    async setup(host, account, config) {
      runtime = { account, config };
      const keys = createRemoteJWKSet(validateEndpointUrl(config.jwksUrl, config.allowLoopback), {
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
