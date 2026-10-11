import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Json, SendInput } from "@relanox/sdk";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
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
async function setup(endorsements = ["msteams"], filename = ":memory:") {
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
    trustedUploadOrigins: [remote.base],
    jwksUrl: `${remote.base}/keys`,
    tokenUrl: `${remote.base}/token`,
    allowLoopback: true,
  };
  const plugin = createTeamsChannel();
  const local = await harness(plugin, config, "conversation-1", "user-id", "root-1", filename);
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
  it.each(["?", "#"])(
    "rejects a signed service base with a bare '%s' delimiter",
    async (suffix) => {
      const local = await setup();
      const serviceUrl = `${local.activity.serviceUrl}${suffix}`;
      const response = await local.core.fetch(
        await local.incoming({ serviceurl: serviceUrl }, { ...local.activity, serviceUrl }),
      );
      expect(response.status).toBe(401);
      expect((await local.storage.getStats()).pending).toBe(0);
    },
  );

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
        appId: "app-id",
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

  it.each(["application identity", "service origin trust"])(
    "rejects frozen targets after %s changes across SQLite reopen",
    async (change) => {
      const directory = await mkdtemp(join(tmpdir(), "relanox-teams-identity-"));
      cleanup.push(() => rm(directory, { recursive: true, force: true }));
      const filename = join(directory, "state.db");
      const local = await setup(["msteams"], filename);
      expect((await local.core.fetch(await local.incoming())).status).toBe(200);
      await local.close();
      const plugin = createTeamsChannel();
      const reopened = await harness(
        plugin,
        {
          ...local.config,
          ...(change === "application identity"
            ? { appId: "replacement-app" }
            : { trustedServiceOrigins: ["https://replacement.invalid"] }),
        },
        "conversation-1",
        "user-id",
        "root-1",
        filename,
      );
      cleanup.push(reopened.close);
      const item = (await reopened.storage.listInbound({ limit: 10 }))[0];
      if (!item) {
        throw new Error("Missing frozen target");
      }
      const input: SendInput = {
        deliveryId: "delivery",
        requestId: item.snapshot.requestId,
        chunkIndex: 0,
        signal: new AbortController().signal,
        target: item.snapshot.target,
        chunk: { text: "answer", idempotencyKey: "delivery:0", state: null },
      };
      expect(await plugin.send(input)).toMatchObject({ status: "rejected" });
      expect(
        local.remote.traffic.filter((entry) => entry.path.startsWith("/teams/v3")),
      ).toHaveLength(0);
      await reopened.close();
      vi.stubEnv("TEAMS_SECRET", "rotated-secret");
      const restoredPlugin = createTeamsChannel();
      const restored = await harness(
        restoredPlugin,
        local.config,
        "conversation-1",
        "user-id",
        "root-1",
        filename,
      );
      cleanup.push(restored.close);
      const legacy = z.record(z.string(), z.json()).parse(input.target.data);
      delete legacy.appId;
      expect(
        await restoredPlugin.send({ ...input, target: { ...input.target, data: legacy } }),
      ).toMatchObject({ status: "rejected" });
      expect(await restoredPlugin.send(input)).toMatchObject({ status: "sent" });
    },
  );

  it.each([
    [503, "pending"],
    [429, "pending"],
    [401, "rejected"],
  ] as const)("classifies OAuth HTTP %s before sending as %s", async (status, expected) => {
    const local = await setup();
    await local.core.fetch(await local.incoming());
    local.remote.token(status, { error: "temporarily_unavailable" });
    const completed = await local.complete();
    expect(completed.delivery?.status).toBe(expected);
    expect(
      local.remote.traffic.filter((request) => request.path.startsWith("/teams/v3")),
    ).toHaveLength(0);
    if (expected === "pending") {
      local.remote.token(200, { access_token: "recovered-token" });
      await expect
        .poll(
          async () => {
            await local.core.processDue();
            return (await local.storage.getOutbound(completed.delivery?.deliveryId ?? "missing"))
              ?.status;
          },
          { timeout: 5000 },
        )
        .toBe("sent");
      expect(
        local.remote.traffic.filter((request) => request.path.startsWith("/teams/v3")),
      ).toHaveLength(1);
    }
  });

  it("forwards opaque OAuth tokens longer than entity identifiers intact", async () => {
    const local = await setup();
    const token = `opaque-token-${"a".repeat(2048)}`;
    local.remote.token(200, { access_token: token });
    await local.core.fetch(await local.incoming());
    expect((await local.complete()).delivery?.status).toBe("sent");
    const sent = local.remote.traffic.find((request) => request.path.startsWith("/teams/v3"));
    expect(sent?.headers.authorization).toBe(`Bearer ${token}`);
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

it("Teams persists pure image attachments and sends the actual inline bytes with app identity", async () => {
  const local = await setup();
  const bytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 8, 9]);
  local.remote.route("/inline", bytes, { "content-type": "image/png" });
  const incoming = {
    ...local.activity,
    text: "",
    attachments: [
      { contentType: "image/png", contentUrl: `${local.remote.base}/inline`, name: "image.png" },
    ],
  };
  expect((await local.core.fetch(await local.incoming({}, incoming))).status).toBe(200);
  const scoped = local.principal();
  const item = (await scoped.listPending(10))[0];
  if (!item?.attachments?.[0]) {
    throw new Error("missing_media");
  }
  const claim = await scoped.claim(item.requestId, "image-claim");
  if (claim.status !== "claimed") {
    throw new Error("claim_failed");
  }
  await scoped.complete({
    requestId: item.requestId,
    claimToken: claim.claimToken,
    resultId: "image-result",
    text: "",
    attachments: [item.attachments[0].id],
  });
  await local.core.processDue();
  const sent = local.remote.traffic.find((request) => request.path.includes("/activities/"));
  expect(JSON.parse(sent?.body ?? "null") as unknown).toMatchObject({
    from: { id: "bot-id" },
    recipient: { id: "user-id" },
    replyToId: "root-1",
    attachments: [
      {
        contentType: "image/png",
        name: "image.png",
        contentUrl: `data:image/png;base64,${Buffer.from(bytes).toString("base64")}`,
      },
    ],
  });
  expect(
    local.remote.traffic.find((request) => request.path === "/inline")?.headers.authorization,
  ).toBe("Bearer oauth-token");
});

it("Teams sends a native consent card, preserves it across restart and PUTs actual file bytes", async () => {
  const directory = await mkdtemp(join(tmpdir(), "relanox-teams-media-"));
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
  const filename = join(directory, "state.db");
  const local = await setup(["msteams"], filename);
  const bytes = new Uint8Array([10, 20, 30, 40]);
  local.remote.route("/file", bytes, { "content-type": "application/pdf" });
  local.remote.route("/upload", {});
  const incoming = {
    ...local.activity,
    text: "",
    conversation: { ...local.activity.conversation, conversationType: "personal" },
    attachments: [
      {
        contentType: "application/vnd.microsoft.teams.file.download.info",
        name: "report.pdf",
        content: { downloadUrl: `${local.remote.base}/file` },
      },
    ],
  };
  expect((await local.core.fetch(await local.incoming({}, incoming))).status).toBe(200);
  const scoped = local.principal();
  const item = (await scoped.listPending(10))[0];
  if (!item?.attachments?.[0]) {
    throw new Error("missing_media");
  }
  const claim = await scoped.claim(item.requestId, "file-claim");
  if (claim.status !== "claimed") {
    throw new Error("claim_failed");
  }
  const media = await scoped.media?.read({
    requestId: item.requestId,
    claimToken: claim.claimToken,
    mediaId: item.attachments[0].id,
  });
  if (!media) {
    throw new Error("missing_media_bytes");
  }
  const input: SendInput = {
    deliveryId: "file-delivery",
    requestId: item.requestId,
    target: item.target,
    chunkIndex: 0,
    chunk: { text: "", state: null, idempotencyKey: "file:0", media: media.reference },
    media,
    signal: new AbortController().signal,
  };
  expect(await local.plugin.send(input)).toMatchObject({
    status: "retryable",
    errorCode: "file_consent_pending",
  });
  expect(await local.plugin.send(input)).toMatchObject({
    status: "retryable",
    errorCode: "file_consent_pending",
  });
  expect(
    local.remote.traffic.filter((request) => request.path.includes("/activities/")),
  ).toHaveLength(1);
  await local.close();
  const plugin = createTeamsChannel();
  const restarted = await harness(
    plugin,
    local.config,
    "conversation-1",
    "user-id",
    "root-1",
    filename,
  );
  cleanup.push(restarted.close);
  const resumed = await restarted.principal().media?.read({
    requestId: item.requestId,
    claimToken: claim.claimToken,
    mediaId: media.reference.id,
  });
  if (!resumed) {
    throw new Error("missing_restored_media");
  }
  const resumedInput = { ...input, media: resumed };
  expect(await plugin.send(resumedInput)).toMatchObject({
    status: "retryable",
    errorCode: "file_consent_pending",
  });
  const invoke = {
    ...local.activity,
    type: "invoke",
    name: "fileConsent/invoke",
    value: {
      action: "accept",
      context: { consentId: "file:0" },
      uploadInfo: {
        uploadUrl: `${local.remote.base}/upload`,
        contentUrl: "https://tenant.sharepoint.com/report.pdf",
        uniqueId: "file-id",
        fileType: "pdf",
      },
    },
  };
  expect((await restarted.core.fetch(await local.incoming({}, invoke))).status).toBe(200);
  expect(await plugin.send(resumedInput)).toMatchObject({ status: "sent" });
  const uploaded = local.remote.traffic.find((request) => request.path === "/upload");
  expect(Buffer.from(uploaded?.body ?? "", "utf8")).toEqual(Buffer.from(bytes));
  expect(uploaded?.headers["content-range"]).toBe("bytes 0-3/4");
  expect(uploaded?.headers.authorization).toBeUndefined();
  const sent = local.remote.traffic.filter((request) => request.path.includes("/activities/"));
  expect(JSON.parse(sent[1]?.body ?? "null") as unknown).toMatchObject({
    attachments: [
      {
        contentType: "application/vnd.microsoft.teams.card.file.info",
        content: { uniqueId: "file-id", fileType: "pdf" },
      },
    ],
  });
});
