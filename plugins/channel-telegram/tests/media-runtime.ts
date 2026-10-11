import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import type { ChannelId, Json } from "@relanox/sdk";
import { vi } from "vitest";
import { z } from "zod";
import { startRuntime, validateApp } from "../../../apps/cli/src/runtime.js";
import { availablePort } from "../../../tests/e2e/peer.js";
import { mediaPeer } from "./media-peer.js";

export type MediaRuntime = Awaited<ReturnType<typeof startRuntime>>;
export type Cleanup = () => Promise<void>;
export async function mediaRuntime(
  cleanups: Cleanup[],
  channel: ChannelId,
  config: Json,
  chatId: string,
  threadId?: string,
) {
  const directory = await mkdtemp(join(tmpdir(), "relanox-native-media-"));
  cleanups.push(async () => rm(directory, { recursive: true, force: true }));
  const routine = await mediaPeer(() => ({ json: {} }));
  cleanups.push(routine.close);
  const port = await availablePort();
  vi.stubEnv("MEDIA_AGENT_TOKEN", "media-agent-token");
  vi.stubEnv("MEDIA_ROUTINE_URL", `${routine.origin}/routine`);
  vi.stubEnv("MEDIA_ROUTINE_AUTH", "Bearer media-routine-token");
  const app = validateApp({
    relay: {
      accounts: [{ id: "business", channel, config, allowedSenders: ["42"] }],
      endpoints: [
        {
          id: "media",
          agent: "grok",
          dispatchMode: "push",
          config: {
            mcp: { token: { env: "MEDIA_AGENT_TOKEN" }, allowedHosts: [`127.0.0.1:${port}`] },
            routineUrl: { env: "MEDIA_ROUTINE_URL" },
            routineAuthorization: { env: "MEDIA_ROUTINE_AUTH" },
            routineTransport: "loopback-http",
            timeoutMs: 2000,
          },
        },
      ],
      bindings: [
        { accountId: "business", chatId, ...(threadId ? { threadId } : {}), endpointId: "media" },
      ],
      storage: { plugin: "sqlite", config: { filename: join(directory, "relay.sqlite") } },
      observability: { plugin: "none", config: {} },
    },
    server: {
      port,
      managementPort: 0,
      workerIntervalMs: 20,
      workerStaleMs: 2000,
      shutdownTimeoutMs: 5000,
    },
    ...(channel === "line"
      ? { media: { publicBaseUrl: `http://127.0.0.1:${port}`, allowInsecureLocalhost: true } }
      : {}),
  });
  const start = async () => {
    const runtime = await startRuntime(app);
    cleanups.push(runtime.stop);
    return runtime;
  };
  const client = async (runtime: MediaRuntime) => {
    const connected = new Client(
      { name: "native-media-wire", version: "1.0.0" },
      { versionNegotiation: { mode: { pin: "2026-07-28" } } },
    );
    cleanups.push(async () => connected.close());
    await connected.connect(
      new StreamableHTTPClientTransport(new URL(`${runtime.businessUrl}/agents/grok/mcp/media`), {
        requestInit: {
          headers: { authorization: "Bearer media-agent-token", connection: "close" },
        },
      }),
    );
    return connected;
  };
  return { start, client, routine };
}
export const mediaRequestSchema = z.looseObject({
  requestId: z.string(),
  text: z.string(),
  attachments: z.array(
    z.looseObject({
      id: z.string(),
      kind: z.string(),
      mimeType: z.string(),
      fileName: z.string(),
      size: z.number(),
    }),
  ),
});
export async function claimMedia(client: Client) {
  const pending = z
    .object({ requests: z.array(mediaRequestSchema) })
    .parse(
      (await client.callTool({ name: "relanox_list_pending", arguments: {} })).structuredContent,
    );
  const request = pending.requests[0];
  if (!request) {
    throw new Error("missing_media_request");
  }
  const claim = z.looseObject({ status: z.literal("claimed"), claimToken: z.string() }).parse(
    (
      await client.callTool({
        name: "relanox_claim",
        arguments: { requestId: request.requestId, claimKey: "media-run" },
      })
    ).structuredContent,
  );
  return { request, claimToken: claim.claimToken };
}
export async function mediaUrl(
  client: Client,
  requestId: string,
  claimToken: string,
  mediaId: string,
  method: "GET" | "PUT",
  metadata?: Json,
) {
  const result = await client.callTool({
    name: "relanox_media_transfer",
    arguments: {
      requestId,
      claimToken,
      mediaId,
      method,
      ...(metadata === undefined ? {} : { metadata }),
    },
  });
  return z.object({ url: z.url() }).parse(result.structuredContent).url;
}
