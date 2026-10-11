import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { AgentId } from "@relanox/sdk";
import { createGrokAgentPlugin } from "../../agent-grok/src/index.js";
import { createDotAgentPlugin } from "../src/index.js";
import { fixture, mcp } from "./fixture.js";

const cleanups: (() => Promise<void>)[] = [];
beforeEach(() => {
  process.env.AGENT_TEST_TOKEN_0 = "secret-0";
  process.env.AGENT_TEST_TOKEN_1 = "secret-1";
});
afterEach(async () => {
  vi.restoreAllMocks();
  for (const cleanup of cleanups.splice(0).toReversed()) {
    await cleanup();
  }
  delete process.env.AGENT_TEST_TOKEN_0;
  delete process.env.AGENT_TEST_TOKEN_1;
});
async function setup(agent: AgentId) {
  const config =
    agent === "dot"
      ? { mcp: mcp(), callback: { allowedOrigins: ["https://callback.test"] } }
      : {
          mcp: mcp(),
          routineUrl: { env: "UNUSED_ROUTINE_URL" },
          routineAuthorization: { env: "UNUSED_ROUTINE_AUTH" },
        };
  const plugin = agent === "dot" ? createDotAgentPlugin() : createGrokAgentPlugin();
  const fx = await fixture(
    agent,
    plugin,
    [config, { ...config, mcp: mcp("AGENT_TEST_TOKEN_1") }],
    false,
  );
  cleanups.push(() => fx.close());
  return fx;
}
const claimSchema = z.looseObject({
  status: z.literal("claimed"),
  claimToken: z.string(),
  request: z.looseObject({
    attachments: z.array(
      z.looseObject({ id: z.string(), kind: z.string(), fileName: z.string(), size: z.number() }),
    ),
  }),
});
const transferSchema = z.looseObject({ url: z.url(), maxBytes: z.number() });

describe.each(["dot", "grok"] as const)("%s native MCP media", (agent) => {
  it("projects inbound metadata, exposes image/audio bytes, transfers binary files and completes ordered media through SQLite", async () => {
    const fx = await setup(agent);
    const png = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=",
      "base64",
    );
    const audio = Buffer.from("RIFF-relanox-audio", "utf8");
    const file = Buffer.from("inbound file bytes", "utf8");
    const receipt = await fx.ingest(0, "inspect these assets", "media-event", [
      { kind: "image", mimeType: "image/png", fileName: "pixel.png", data: png },
      { kind: "audio", mimeType: "audio/wav", fileName: "voice.wav", data: audio },
      { kind: "file", mimeType: "application/octet-stream", fileName: "input.bin", data: file },
    ]);
    const client = await fx.client();
    const pending = await client.callTool({ name: "relanox_list_pending", arguments: {} });
    expect(pending).toMatchObject({
      structuredContent: {
        requests: [
          {
            attachments: [
              { kind: "image", fileName: "pixel.png" },
              { kind: "audio", fileName: "voice.wav" },
              { kind: "file", fileName: "input.bin" },
            ],
          },
        ],
      },
    });
    const claimed = claimSchema.parse(
      (
        await client.callTool({
          name: "relanox_claim",
          arguments: { requestId: receipt.requestId, claimKey: "media-run" },
        })
      ).structuredContent,
    );
    const common = { requestId: receipt.requestId, claimToken: claimed.claimToken };
    const [image, sound, document] = claimed.request.attachments;
    if (!image || !sound || !document) {
      throw new Error("media_metadata_missing");
    }
    expect(
      await client.callTool({
        name: "relanox_read_media",
        arguments: { ...common, mediaId: image.id },
      }),
    ).toMatchObject({
      content: [{ type: "image", data: png.toString("base64"), mimeType: "image/png" }],
    });
    expect(
      await client.callTool({
        name: "relanox_read_media",
        arguments: { ...common, mediaId: sound.id },
      }),
    ).toMatchObject({
      content: [{ type: "audio", data: audio.toString("base64"), mimeType: "audio/wav" }],
    });
    const download = await client.callTool({
      name: "relanox_read_media",
      arguments: { ...common, mediaId: document.id },
    });
    const link = z
      .object({
        content: z.array(
          z.looseObject({ type: z.literal("resource_link"), uri: z.url(), name: z.string() }),
        ),
      })
      .parse(download).content[0];
    if (!link) {
      throw new Error("media_download_missing");
    }
    expect(link.name).toBe("input.bin");
    const fetched = await fx.core.fetch(new Request(link.uri));
    expect(fetched.status).toBe(200);
    expect(fetched.headers.get("x-content-type-options")).toBe("nosniff");
    expect(new Uint8Array(await fetched.arrayBuffer())).toEqual(new Uint8Array(file));
    const uploadId = randomUUID();
    const transfer = transferSchema.parse(
      (
        await client.callTool({
          name: "relanox_media_transfer",
          arguments: {
            ...common,
            mediaId: uploadId,
            method: "PUT",
            metadata: {
              kind: "video",
              mimeType: "video/mp4",
              fileName: "generated.mp4",
              durationMs: 2500,
              previewMediaId: image.id,
            },
          },
        })
      ).structuredContent,
    );
    expect(new URL(transfer.url).origin).toBe("http://relanox.test");
    expect(transfer.url).not.toContain("secret-0");
    const generated = Buffer.alloc(3_000_000, 23);
    const put = () => fx.core.fetch(new Request(transfer.url, { method: "PUT", body: generated }));
    expect(await (await put()).json()).toMatchObject({
      status: "stored",
      replay: false,
      media: { id: uploadId, size: generated.length, durationMs: 2500, previewMediaId: image.id },
    });
    expect(await (await put()).json()).toMatchObject({ status: "stored", replay: true });
    const conflicting = await fx.core.fetch(
      new Request(transfer.url, { method: "PUT", body: Buffer.from("different") }),
    );
    expect(await conflicting.json()).toEqual({ status: "conflict" });
    await fx.reopen(agent === "dot" ? createDotAgentPlugin() : createGrokAgentPlugin());
    const afterRestart = await fx.core.fetch(new Request(link.uri));
    expect(afterRestart.status).toBe(200);
    expect(new Uint8Array(await afterRestart.arrayBuffer())).toEqual(new Uint8Array(file));
    const completion = {
      ...common,
      resultId: "media-result",
      text: "done",
      attachments: [uploadId, document.id],
    };
    expect(
      await client.callTool({ name: "relanox_complete", arguments: completion }),
    ).toMatchObject({ structuredContent: { status: "completed", replay: false } });
    expect(
      await client.callTool({ name: "relanox_complete", arguments: completion }),
    ).toMatchObject({ structuredContent: { status: "completed", replay: true } });
    await fx.core.processDue();
    expect(fx.sent).toMatchObject([
      { chunk: { text: "done" } },
      {
        media: { reference: { id: uploadId, durationMs: 2500, previewMediaId: image.id } },
        preview: { reference: { id: image.id }, data: new Uint8Array(png) },
      },
      { media: { reference: { id: document.id } } },
    ]);
    const sentMedia = z
      .looseObject({ media: z.looseObject({ data: z.instanceof(Uint8Array) }) })
      .parse(fx.sent[1]);
    expect(Buffer.from(sentMedia.media.data).equals(generated)).toBe(true);
  });

  it("rejects tampered, cross-endpoint, expired and revoked capabilities, and authorizes before reading an upload body", async () => {
    const fx = await setup(agent);
    const receipt = await fx.ingest();
    const client = await fx.client();
    const result = await client.callTool({
      name: "relanox_claim",
      arguments: { requestId: receipt.requestId, claimKey: "capability-run" },
    });
    const claimToken = z
      .looseObject({ claimToken: z.string() })
      .parse(result.structuredContent).claimToken;
    const uploadId = randomUUID();
    const transfer = transferSchema.parse(
      (
        await client.callTool({
          name: "relanox_media_transfer",
          arguments: {
            requestId: receipt.requestId,
            claimToken,
            mediaId: uploadId,
            method: "PUT",
            metadata: { kind: "file", mimeType: "application/octet-stream", fileName: "safe.bin" },
          },
        })
      ).structuredContent,
    );
    const tampered = new URL(transfer.url);
    tampered.searchParams.set("ticket", `${tampered.searchParams.get("ticket")}x`);
    let bodyReads = 0;
    const stalledBody = new ReadableStream<Uint8Array>(
      {
        pull() {
          bodyReads += 1;
        },
      },
      { highWaterMark: 0 },
    );
    const init: RequestInit & { duplex: "half" } = {
      method: "PUT",
      body: stalledBody,
      duplex: "half",
    };
    expect((await fx.core.fetch(new Request(tampered, init))).status).toBe(401);
    expect(bodyReads).toBe(0);
    expect(
      (
        await fx.core.fetch(
          new Request(transfer.url.replace("endpoint0", "endpoint1"), {
            method: "PUT",
            body: "bytes",
          }),
        )
      ).status,
    ).toBe(401);
    const now = Date.now();
    const clock = vi.spyOn(Date, "now").mockReturnValue(now + 300_001);
    expect(
      (await fx.core.fetch(new Request(transfer.url, { method: "PUT", body: "bytes" }))).status,
    ).toBe(401);
    clock.mockRestore();
    const request = await fx.storage.getInbound(receipt.requestId);
    if (!request) {
      throw new Error("request_missing");
    }
    expect(
      await fx.core.requeue({
        kind: "request",
        id: receipt.requestId,
        expectedVersion: request.version,
        acknowledgeUnknown: true,
      }),
    ).toMatchObject({ status: "updated" });
    const stale = await fx.core.fetch(new Request(transfer.url, { method: "PUT", body: "bytes" }));
    expect(await stale.json()).toEqual({ status: "unauthorized" });
    expect(await fx.storage.media?.get(receipt.requestId, uploadId)).toBeUndefined();
  });
});
