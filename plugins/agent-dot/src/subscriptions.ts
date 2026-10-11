import { createHash, randomBytes, randomUUID } from "node:crypto";
import { ProtocolError } from "@modelcontextprotocol/server";
import type { AgentHost, EndpointConfig, Json, StateEntry } from "@relanox/sdk";
import { Webhook } from "standardwebhooks";
import { z } from "zod";
import { CallbackError, callbackUrl, postCallback } from "./callback.js";
import type { DotConfig } from "./config.js";
import { equalSecret } from "./mcp.js";
import { name, subscriptionSchema } from "./protocol.js";
import type { Subscription, subscribeParams, unsubscribeParams } from "./protocol.js";

const canonical = (value: unknown): string =>
  JSON.stringify(value, (_key, v: unknown) =>
    v !== null && typeof v === "object" && !Array.isArray(v)
      ? Object.fromEntries(Object.entries(v).toSorted(([a], [b]) => a.localeCompare(b)))
      : v,
  );
function identity(owner: string, url: string, eventArgs: unknown): string {
  return `sub_${createHash("sha256")
    .update(canonical({ owner, url, name, arguments: eventArgs }))
    .digest("hex")}`;
}
export function signedHeaders(
  sub: Subscription,
  body: string,
  eventId: string,
): Record<string, string> {
  const now = new Date();
  const signatures = [new Webhook(sub.secret).sign(eventId, now, body)];
  if (sub.previousSecret !== undefined && (sub.previousUntil ?? 0) > now.getTime()) {
    signatures.push(new Webhook(sub.previousSecret).sign(eventId, now, body));
  }
  return {
    "Content-Type": "application/json",
    "webhook-id": eventId,
    "webhook-timestamp": String(Math.floor(now.getTime() / 1000)),
    "webhook-signature": signatures.join(" "),
    "X-MCP-Subscription-Id": sub.id,
  };
}
function callbackProtocolError(reason: string): ProtocolError {
  return new ProtocolError(-32_015, "CallbackEndpointError", { reason });
}
function rotationFields(
  old: Subscription | undefined,
  secret: string,
  now: number,
  config: DotConfig,
): Pick<Subscription, "previousSecret" | "previousUntil"> {
  if (old !== undefined && old.secret !== secret) {
    return { previousSecret: old.secret, previousUntil: now + config.rotationWindowMs };
  }
  if (old?.previousSecret !== undefined && (old.previousUntil ?? 0) > now) {
    return { previousSecret: old.previousSecret, previousUntil: old.previousUntil ?? now };
  }
  return {};
}
async function verifySubscription(sub: Subscription, config: DotConfig): Promise<void> {
  const challenge = randomBytes(32).toString("base64url");
  const challengeBody = JSON.stringify({ type: "verification", challenge });
  try {
    const response = await postCallback(
      sub.url,
      config.callback,
      challengeBody,
      signedHeaders(sub, challengeBody, `verification_${randomUUID()}`),
      AbortSignal.timeout(config.callback.timeoutMs),
      "body",
    );
    const echoed = z.strictObject({ challenge: z.string() }).safeParse(JSON.parse(response.body));
    if (
      response.status < 200 ||
      response.status >= 300 ||
      !echoed.success ||
      !equalSecret(challenge, echoed.data.challenge)
    ) {
      throw callbackProtocolError("challenge_failed");
    }
  } catch (error) {
    if (error instanceof ProtocolError) {
      throw error;
    }
    throw callbackProtocolError(error instanceof CallbackError ? error.reason : "challenge_failed");
  }
}
export function createSubscriptions(host: AgentHost) {
  async function activeEntries(endpointId: string): Promise<readonly StateEntry[]> {
    return host.state.list({
      prefix: `subscriptions/${endpointId}/`,
      limit: 1000,
    });
  }
  async function checkSubscriptionCapacity(owner: string, now: number): Promise<void> {
    const entries = await activeEntries(owner);
    for (const entry of entries) {
      if ((entry.expiresAt ?? Infinity) <= now) {
        await host.state.delete(entry.key, entry.version);
      }
    }
    if (entries.filter((entry) => (entry.expiresAt ?? Infinity) > now).length >= 100) {
      throw new ProtocolError(-32_000, "subscription_limit");
    }
  }
  async function subscribe(
    endpoint: EndpointConfig,
    config: DotConfig,
    input: z.infer<typeof subscribeParams>,
  ): Promise<{
    id: string;
    refreshBefore: string;
    cursor: null;
    truncated: false;
  }> {
    const owner = endpoint.id;
    let url: string;
    try {
      url = callbackUrl(input.delivery.url, config.callback).href;
    } catch {
      throw callbackProtocolError("forbidden_destination");
    }
    const id = identity(owner, url, input.arguments);
    const key = `subscriptions/${owner}/${id}`;
    const existing = await host.state.get(key);
    const old = existing ? subscriptionSchema.parse(existing.value) : undefined;
    const now = Date.now();
    const expiresAt =
      now + Math.min(input.ttlMs ?? config.subscriptionTtlMs, config.subscriptionTtlMs);
    const replacement = old !== undefined && old.secret !== input.delivery.secret;
    const sub: Subscription = {
      id,
      owner,
      endpointId: endpoint.id,
      name,
      arguments: input.arguments,
      url,
      secret: input.delivery.secret,
      expiresAt,
      verifiedAt: now,
      ...rotationFields(old, input.delivery.secret, now, config),
    };
    // Verification cache is durable, short-lived and bound to owner, URL AND signing key.
    if (!old || old.expiresAt <= now || replacement || now - old.verifiedAt > 60_000) {
      await verifySubscription(sub, config);
    } else {
      sub.verifiedAt = old.verifiedAt;
    }
    if (!existing) {
      await checkSubscriptionCapacity(owner, now);
    }
    const mutation = await host.state.compareAndSet({
      key,
      expectedVersion: existing?.version ?? null,
      value: JSON.parse(JSON.stringify(sub)) as Json,
      expiresAt,
    });
    if (mutation.status !== "updated") {
      throw new ProtocolError(-32_000, "subscription_conflict");
    }
    return {
      id,
      refreshBefore: new Date(expiresAt).toISOString(),
      cursor: null,
      truncated: false,
    };
  }
  async function unsubscribe(
    endpoint: EndpointConfig,
    input: z.infer<typeof unsubscribeParams>,
  ): Promise<Record<string, never>> {
    const url = new URL(input.delivery.url).href;
    const key = `subscriptions/${endpoint.id}/${identity(endpoint.id, url, input.arguments)}`;
    const entry = await host.state.get(key);
    if (entry && (await host.state.delete(key, entry.version)).status !== "updated") {
      throw new ProtocolError(-32_000, "subscription_conflict");
    }
    return {};
  }
  return { activeEntries, subscribe, unsubscribe };
}
