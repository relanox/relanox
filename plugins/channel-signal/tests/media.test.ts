import { expect, it } from "vitest";
import { z } from "zod";
import { body, httpPeer, json, waitFor } from "../../channel-matrix/tests/harness.js";
import { mediaRelay } from "../../channel-matrix/tests/media-harness.js";
import { createSignalChannel } from "../src/index.js";

const kinds = [
  ["image", "image/png", "picture.png"],
  ["audio", "audio/ogg", "voice.ogg"],
  ["video", "video/mp4", "clip.mp4"],
  ["file", "application/pdf", "report.pdf"],
] as const;
const rpcSchema = z.object({
  id: z.string(),
  method: z.string(),
  params: z.record(z.string(), z.unknown()),
});

it.each(kinds)(
  "relays Signal %s through native getAttachment, SQLite, real MCP and data URI sending",
  async (kind, mimeType, fileName) => {
    const downloads: unknown[] = [];
    const sends: unknown[] = [];
    const peer = await httpPeer(async (request, response) => {
      if (request.url?.startsWith("/api/v1/events")) {
        response.writeHead(200, { "Content-Type": "text/event-stream" });
        response.write(
          `id: media-event\nevent: receive\ndata: ${JSON.stringify({ account: "+10000000001", envelope: { sourceUuid: "alice-uuid", timestamp: 1, dataMessage: { timestamp: 1, message: null, groupInfo: { groupId: "GROUP=" }, attachments: [{ id: "original", contentType: kind === "audio" ? `${mimeType}; codecs=opus` : mimeType, filename: fileName, size: 3 }] } } })}\n\n`,
        );
        return;
      }
      expect(request.headers.authorization).toBe("Bearer signal-secret");
      const rpc = rpcSchema.parse(await body(request));
      if (rpc.method === "getAttachment") {
        downloads.push(rpc.params);
        json(response, { jsonrpc: "2.0", id: rpc.id, result: { data: "AQID" } });
      } else {
        sends.push(rpc.params);
        json(response, {
          jsonrpc: "2.0",
          id: rpc.id,
          result: { timestamp: 1234, results: [{ type: "SUCCESS" }] },
        });
      }
    });
    const plugin = createSignalChannel({ SIGNAL_AUTH: "Bearer signal-secret" });
    const fixture = await mediaRelay(
      plugin,
      {
        serviceUrl: peer.base,
        account: "+10000000001",
        authorization: { env: "SIGNAL_AUTH" },
        allowInsecureLocalhost: true,
        reconnectMs: 100,
      },
      [{ chatId: "group:GROUP=" }],
      ["alice-uuid"],
    );
    await plugin.start?.(new AbortController().signal);
    await waitFor(async () => (await fixture.storage.listInbound({ limit: 10 })).length === 1);
    await plugin.stop?.();
    const record = (await fixture.storage.listInbound({ limit: 10 }))[0];
    if (!record) {
      throw new Error("Expected inbound");
    }
    const turn = await fixture.turn(record.snapshot.requestId, [
      { kind, mimeType, fileName, data: new Uint8Array([9, 8, 7]) },
    ]);
    expect(turn.inbound[0]?.reference).toMatchObject({ kind, mimeType, fileName });
    expect(turn.inbound[0]?.data).toEqual(new Uint8Array([1, 2, 3]));
    expect(downloads).toEqual([{ account: "+10000000001", id: "original", groupId: "GROUP=" }]);
    expect(
      (await fixture.storage.getState({ pluginId: "channel-signal", ownerId: "bot" }, "events"))
        ?.value,
    ).toBe("media-event");
    await fixture.runtime.processDue();
    expect(sends).toEqual([
      {
        account: "+10000000001",
        groupId: "GROUP=",
        message: "",
        attachments: [`data:${mimeType};filename=${fileName};base64,CQgH`],
      },
    ]);
    expect((await fixture.storage.getOutbound(turn.deliveryId))?.status).toBe("sent");
  },
);

it("rejects over-limit Signal attachment data without advancing the event cursor", async () => {
  let read = false;
  const peer = await httpPeer(async (request, response) => {
    if (request.url?.startsWith("/api/v1/events")) {
      response.writeHead(200, { "Content-Type": "text/event-stream" });
      response.write(
        `id: not-committed\ndata: ${JSON.stringify({ account: "+10000000001", envelope: { sourceUuid: "alice", timestamp: 1, dataMessage: { timestamp: 1, attachments: [{ id: "large", contentType: "image/png", filename: "large.png" }] } } })}\n\n`,
      );
    } else {
      const rpc = rpcSchema.parse(await body(request));
      read = true;
      json(response, {
        jsonrpc: "2.0",
        id: rpc.id,
        result: { data: Buffer.alloc(17).toString("base64") },
      });
    }
  });
  const plugin = createSignalChannel();
  const fixture = await mediaRelay(
    plugin,
    {
      serviceUrl: peer.base,
      account: "+10000000001",
      allowInsecureLocalhost: true,
      reconnectMs: 100,
    },
    [{ chatId: "direct:alice" }],
    ["alice"],
    16,
  );
  await plugin.start?.(new AbortController().signal);
  await waitFor(() => read);
  await plugin.stop?.();
  expect(await fixture.storage.listInbound({ limit: 10 })).toEqual([]);
  expect(
    await fixture.storage.getState({ pluginId: "channel-signal", ownerId: "bot" }, "events"),
  ).toBeUndefined();
});
