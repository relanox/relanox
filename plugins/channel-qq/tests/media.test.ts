import { expect, test, vi } from "vitest";
import { z } from "zod";
import { createQqChannel } from "../src/index.js";
import { wireText } from "../src/transport.js";
import { assemble, peer, records } from "../../channel-wecom/tests/test-support.js";

test("QQ downloads pure files into SQLite then uploads published bytes and sends type 7 to the same C2C", async () => {
  vi.stubEnv("QQ_MEDIA_SECRET", "secret");
  const bytes = Buffer.from([10, 20, 30, 40, 50]);
  let websocket = "";
  const runtime: { current?: { fetch(request: Request): Promise<Response> } } = {};
  let actualUpload: Uint8Array | undefined;
  const remote = await peer(
    async (request) => {
      if (request.path === "/app/getAppAccessToken") {
        return { body: { access_token: "native-token", expires_in: 7200 } };
      }
      if (request.path === "/gateway") {
        return { body: { url: websocket } };
      }
      if (request.path === "/report.pdf") {
        return { body: bytes, headers: { "content-type": "application/pdf" } };
      }
      if (request.path.startsWith("/media/")) {
        if (!runtime.current) {
          throw new Error("runtime_not_ready");
        }
        const result = await runtime.current.fetch(new Request(`${remote.http}${request.path}`));
        return {
          status: result.status,
          headers: Object.fromEntries(result.headers),
          body: Buffer.from(await result.arrayBuffer()),
        };
      }
      if (request.path === "/v2/users/user/files") {
        const upload = z.object({ url: z.string() }).parse(request.body);
        actualUpload = new Uint8Array(await (await fetch(upload.url)).arrayBuffer());
        return { body: { file_info: "opaque-file-info", ttl: 60 } };
      }
      return { body: { id: "sent-media" } };
    },
    (socket) => {
      socket.send(JSON.stringify({ op: 10, d: { heartbeat_interval: 1000 } }));
      socket.on("message", (raw) => {
        const received = z.object({ op: z.number() }).parse(JSON.parse(wireText(raw)));
        if (received.op === 2) {
          socket.send(JSON.stringify({ op: 0, s: 1, t: "READY", d: { session_id: "session" } }));
        }
        if (received.op === 1) {
          socket.send(JSON.stringify({ op: 11 }));
        }
      });
    },
  );
  websocket = remote.ws;
  const plugin = createQqChannel();
  const local = await assemble(
    plugin,
    {
      appId: "app",
      clientSecret: { env: "QQ_MEDIA_SECRET" },
      apiBase: remote.http,
      mediaOrigins: [remote.http],
      allowInsecureLoopback: true,
    },
    [{ chatId: "user", senderId: "user" }],
    ":memory:",
    remote.http,
  );
  runtime.current = local.runtime;
  await local.start();
  await expect.poll(() => remote.frames.length).toBeGreaterThan(0);
  remote.sockets[0]?.send(
    JSON.stringify({
      op: 0,
      s: 2,
      t: "C2C_MESSAGE_CREATE",
      d: {
        id: "file-in",
        content: "",
        timestamp: new Date().toISOString(),
        message_type: 7,
        author: { user_openid: "user" },
        attachments: [
          {
            url: `${remote.http}/report.pdf`,
            filename: "report.pdf",
            content_type: "application/pdf",
          },
        ],
      },
    }),
  );
  await expect.poll(async () => (await records(local.storage)).length).toBe(1);
  const scoped = local.principal();
  const item = (await scoped.listPending(10))[0];
  if (!item?.attachments?.[0]) {
    throw new Error("missing_media");
  }
  const claim = await scoped.claim(item.requestId, "file-claim");
  if (claim.status !== "claimed") {
    throw new Error("claim_failed");
  }
  await scoped.complete({
    requestId: item.requestId,
    claimToken: claim.claimToken,
    resultId: "file-result",
    text: "caption",
    attachments: [item.attachments[0].id],
  });
  await local.runtime.processDue();
  expect(actualUpload).toEqual(new Uint8Array(bytes));
  expect(
    remote.requests.find((request) => request.path === "/v2/users/user/files")?.body,
  ).toMatchObject({ file_type: 4, file_name: "report.pdf", srv_send_msg: false });
  expect(remote.requests).toContainEqual(
    expect.objectContaining({
      path: "/v2/users/user/messages",
      body: {
        content: "",
        msg_type: 7,
        media: { file_info: "opaque-file-info" },
        msg_id: "file-in",
        msg_seq: 2,
      },
    }),
  );
});
