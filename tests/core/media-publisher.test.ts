import { createServer } from "node:http";
import { once } from "node:events";
import { DatabaseSync } from "node:sqlite";
import { expect, it } from "vitest";
import { incoming, mediaFixture, picture } from "./fixture.js";

async function throughHttp(
  runtime: { fetch(request: Request): Promise<Response> },
  publishedUrl: string,
): Promise<Response> {
  const server = createServer((request, response) => {
    void runtime
      .fetch(new Request(`http://127.0.0.1${request.url ?? "/"}`))
      .then(async (result) => {
        response.writeHead(result.status, Object.fromEntries(result.headers));
        response.end(new Uint8Array(await result.arrayBuffer()));
        return null;
      })
      .catch(() => {
        response.writeHead(500);
        response.end();
      });
  });

  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("Expected listener");
  }
  const path = new URL(publishedUrl);
  try {
    const response = await fetch(`http://127.0.0.1:${address.port}${path.pathname}${path.search}`);
    return new Response(await response.arrayBuffer(), {
      status: response.status,
      headers: response.headers,
    });
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error) {
          reject(error);
        } else {
          resolve();
        }
      });
    });
  }
}

it("serves scoped durable capability URLs across SQLite restart and rejects invalid capabilities", async () => {
  const f = await mediaFixture(undefined, { publicBaseUrl: "https://media.example" });
  try {
    const receipt = await f.channel.ingest({ ...incoming, attachments: [picture] });
    const record = await f.storage.getInbound(receipt.requestId);
    const id = record?.snapshot.attachments?.[0]?.id;
    if (!id || !f.channel.media) {
      throw new Error("Expected publisher");
    }
    const input = { requestId: receipt.requestId, mediaId: id };
    const url = await f.channel.media.publish(input);
    expect(url).toMatch(/^https:\/\/media\.example\/media\/bot\/.+\?token=[a-f0-9]{64}$/u);
    expect(await f.channel.media.publish(input)).toBe(url);
    await expect(
      f.channel.media.publish({ ...input, requestId: crypto.randomUUID() }),
    ).rejects.toMatchObject({ code: "account_scope_mismatch" });
    let runtime = f.runtime;
    for (const candidate of [url, url]) {
      const response = await throughHttp(runtime, candidate);
      expect(response.status).toBe(200);
      expect(new Uint8Array(await response.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]));
      expect(response.headers.get("content-type")).toBe("image/png");
      expect(response.headers.get("content-disposition")).toBe(
        "attachment; filename*=UTF-8''picture.png",
      );
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(response.headers.get("x-content-type-options")).toBe("nosniff");
      runtime = await f.restart();
    }
    expect((await runtime.fetch(new Request(url.replace("/bot/", "/other/")))).status).toBe(404);
    expect(
      (await runtime.fetch(new Request(url.replace(/token=.+$/u, "token=wrong")))).status,
    ).toBe(404);
    const database = new DatabaseSync(f.filename);
    database.prepare("UPDATE media SET data=NULL WHERE id=?").run(id);
    database.close();
    expect((await runtime.fetch(new Request(url))).status).toBe(404);
  } finally {
    await f.close();
  }
});

it("expires public URLs and prunes expired durable tickets before publishing", async () => {
  const f = await mediaFixture(undefined, {
    publicBaseUrl: "https://media.example",
    urlLifetimeMs: 1,
  });

  try {
    const receipt = await f.channel.ingest({ ...incoming, attachments: [picture] });
    const id = (await f.storage.getInbound(receipt.requestId))?.snapshot.attachments?.[0]?.id;
    if (!id || !f.channel.media) {
      throw new Error("Expected publisher");
    }
    const url = await f.channel.media.publish({ requestId: receipt.requestId, mediaId: id });
    await new Promise((resolve) => {
      setTimeout(resolve, 10);
    });
    expect((await f.runtime.fetch(new Request(url))).status).toBe(404);
    const renewed = await f.channel.media.publish({ requestId: receipt.requestId, mediaId: id });
    expect(renewed).not.toBe(url);
    expect(
      await f.storage.listState(
        { pluginId: "core-media-publisher", ownerId: "bot" },
        { limit: 100 },
      ),
    ).toHaveLength(1);
  } finally {
    await f.close();
  }
});

it.each([
  "http://example.com",
  "https://user:secret@example.com",
  "https://example.com/path",
  "http://127.0.0.1",
])("rejects unsafe public media origin %s", async (publicBaseUrl) => {
  await expect(mediaFixture(undefined, { publicBaseUrl })).rejects.toThrow();
});

it("allows explicitly configured loopback HTTP and leaves unconfigured hosts without publishing", async () => {
  const local = await mediaFixture(undefined, {
    publicBaseUrl: "http://127.0.0.1:8080",
    allowInsecureLocalhost: true,
  });

  const absent = await mediaFixture();
  try {
    expect(local.channel.media).toBeDefined();
    expect(absent.channel.media).toBeUndefined();
  } finally {
    await local.close();
    await absent.close();
  }
});
