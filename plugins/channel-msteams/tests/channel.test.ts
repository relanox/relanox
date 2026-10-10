import type { Json } from "@relanox/sdk";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createTeamsChannel } from "../src/index.js";
import { harness, peer } from "./harness.js";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).toReversed()) {
    await close();
  }
  vi.unstubAllEnvs();
});
const issuer = "https://api.botframework.com";
async function setup(endorsements = ["msteams"]) {
  vi.stubEnv("TEAMS_SECRET", "app-secret");
  const remote = await peer();
  cleanup.push(remote.close);
  const keys = await generateKeyPair("RS256");
  remote.keys({
    keys: [{ ...(await exportJWK(keys.publicKey)), kid: "teams-key", endorsements }],
  });
  remote.respond(200, { id: "activity-sent" });
  const config: Json = {
    appId: "app-id",
    botId: "bot-id",
    tenantId: "tenant-id",
    appSecret: { env: "TEAMS_SECRET" },
    trustedServiceOrigins: [remote.base],
    jwksUrl: `${remote.base}/keys`,
    tokenUrl: `${remote.base}/token`,
    allowLoopback: true,
  };
  const plugin = createTeamsChannel();
  const local = await harness(plugin, config, "conversation-1", "user-id", "root-1");
  cleanup.push(local.close);
  const activity = {
    type: "message",
    id: "activity-1",
    channelId: "msteams",
    serviceUrl: `${remote.base}/teams/`,
    text: "hello",
    from: { id: "user-id" },
    recipient: { id: "bot-id" },
    conversation: { id: "conversation-1", tenantId: "tenant-id" },
    channelData: { tenant: { id: "tenant-id" } },
    replyToId: "root-1",
  };
  async function incoming(
    claims: { iss?: string; aud?: string; serviceurl?: string; exp?: string } = {},
    body: unknown = activity,
  ) {
    const token = await new SignJWT({ serviceurl: claims.serviceurl ?? activity.serviceUrl })
      .setProtectedHeader({ alg: "RS256", kid: "teams-key" })
      .setIssuer(claims.iss ?? issuer)
      .setAudience(claims.aud ?? "app-id")
      .setIssuedAt()
      .setNotBefore("-1s")
      .setExpirationTime(claims.exp ?? "5m")
      .sign(keys.privateKey);
    return new Request("http://local/channels/business/activities", {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
    });
  }
  return { remote, config, plugin, activity, incoming, ...local };
}

describe("native Microsoft Teams", () => {
  it("authenticates endorsed JWT and frozen conversation reference through proactive OAuth send", async () => {
    const local = await setup();
    expect((await local.core.fetch(await local.incoming({}, "{"))).status).toBe(400);
    expect((await local.core.fetch(await local.incoming())).status).toBe(200);
    expect((await local.core.fetch(await local.incoming())).status).toBe(200);
    expect((await local.storage.getStats()).pending).toBe(1);
    const completed = await local.complete();
    expect(completed.delivery?.status).toBe("sent");
    expect(local.dispatches).toEqual(["hello"]);
    expect(completed.request.target).toEqual({
      channel: "msteams",
      accountId: "business",
      chatId: "conversation-1",
      threadId: "root-1",
      replyToId: "activity-1",
      data: {
        serviceUrl: `${local.remote.base}/teams/`,
        conversationId: "conversation-1",
        tenantId: "tenant-id",
        botId: "bot-id",
        userId: "user-id",
        replyToId: "root-1",
      },
    });
    const oauth = local.remote.traffic.find((request) => request.path === "/token");
    const form = new URLSearchParams(oauth?.body);
    expect(Object.fromEntries(form)).toEqual({
      grant_type: "client_credentials",
      client_id: "app-id",
      client_secret: "app-secret",
      scope: "https://api.botframework.com/.default",
    });
    const sent = local.remote.traffic.find((request) => request.path.startsWith("/teams/v3"));
    expect(sent?.path).toBe("/teams/v3/conversations/conversation-1/activities/root-1");
    expect(sent?.headers.authorization).toBe("Bearer oauth-token");
    expect(JSON.parse(sent?.body ?? "null") as unknown).toEqual({
      type: "message",
      text: "answer",
      channelId: "msteams",
      from: { id: "bot-id" },
      recipient: { id: "user-id" },
      conversation: { id: "conversation-1", tenantId: "tenant-id" },
      replyToId: "root-1",
      channelData: { tenant: { id: "tenant-id" } },
    });
  });

  it.each([{ aud: "other-app" }, { iss: "https://attacker.example" }, { exp: "-1s" }])(
    "rejects JWT outside application trust %j",
    async (claims) => {
      const local = await setup();
      expect((await local.core.fetch(await local.incoming(claims))).status).toBe(401);
      expect((await local.storage.getStats()).pending).toBe(0);
    },
  );

  it("rejects unendorsed signing keys, wrong recipient/tenant/channel and untrusted JWT-bound service URLs", async () => {
    const unendorsed = await setup(["other-channel"]);
    expect((await unendorsed.core.fetch(await unendorsed.incoming())).status).toBe(403);
    const local = await setup();
    for (const body of [
      { ...local.activity, recipient: { id: "other-bot" } },
      { ...local.activity, channelData: { tenant: { id: "other-tenant" } } },
      { ...local.activity, channelId: "emulator" },
    ]) {
      expect((await local.core.fetch(await local.incoming({}, body))).status).toBe(403);
    }
    expect(
      (
        await local.core.fetch(
          await local.incoming(
            { serviceurl: "https://attacker.example/" },
            { ...local.activity, serviceUrl: "https://attacker.example/" },
          ),
        )
      ).status,
    ).toBe(401);
    expect(
      (await local.core.fetch(await local.incoming({ serviceurl: "https://mismatch.example/" })))
        .status,
    ).toBe(403);
    expect((await local.storage.getStats()).pending).toBe(0);
  });

  it.each([
    [429, "pending"],
    [403, "rejected"],
    [503, "unknown"],
  ] as const)("classifies HTTP %s as %s", async (status, expected) => {
    const local = await setup();
    await local.core.fetch(await local.incoming());
    local.remote.respond(status, {}, { "retry-after": "2" });
    expect((await local.complete()).delivery?.status).toBe(expected);
    expect(
      local.remote.traffic.filter((request) => request.path.startsWith("/teams/v3")),
    ).toHaveLength(1);
  });

  it("rejects plain credentials and path-bearing trusted origins", () => {
    const plugin = createTeamsChannel();
    expect(() =>
      plugin.validateConfig({
        appId: "app",
        botId: "bot",
        tenantId: "tenant",
        appSecret: "secret",
        trustedServiceOrigins: ["https://smba.trafficmanager.net"],
      }),
    ).toThrow();
    expect(() =>
      plugin.validateConfig({
        appId: "app",
        botId: "bot",
        tenantId: "tenant",
        appSecret: { env: "SECRET" },
        trustedServiceOrigins: ["https://smba.trafficmanager.net/teams"],
      }),
    ).toThrow("service_origins_must_be_origins");
  });
});
