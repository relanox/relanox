import { createServer } from "node:http";
import type { IncomingHttpHeaders, IncomingMessage, Server, ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { noopObservability } from "@relanox/sdk";
import type { ChannelHost, HttpHandler, IngestInput, SendInput } from "@relanox/sdk";

export function recorder(ingest?: (input: IngestInput) => Promise<void>) {
  const received: IngestInput[] = [];
  const handlers = new Map<string, HttpHandler>();
  const connections: string[] = [];

  const unavailable = async (): Promise<never> => {
    throw new Error("state_unavailable");
  };

  const host: ChannelHost = {
    observe: noopObservability,
    state: { get: unavailable, list: unavailable, compareAndSet: unavailable, delete: unavailable },
    mountHttp(path, handler) {
      handlers.set(path, handler);
    },
    connection(status) {
      connections.push(status);
    },
    async ingest(input) {
      await ingest?.(input);
      received.push(input);
      return { requestId: "request-1", duplicate: false };
    },
  };

  return { host, received, handlers, connections };
}

export interface Captured {
  path: string;
  headers: IncomingHttpHeaders;
  body: unknown;
}

interface PeerResponse {
  status?: number;
  headers?: Record<string, string>;
  body: unknown;
}

export async function peer(respond: (input: Captured) => PeerResponse) {
  const requests: Captured[] = [];

  async function handle(request: IncomingMessage, response: ServerResponse) {
    const chunks: Buffer[] = [];
    for await (const chunk of request) {
      const value: unknown = chunk;
      if (!Buffer.isBuffer(value)) {
        throw new TypeError("unexpected_peer_bytes");
      }
      chunks.push(value);
    }

    const body: unknown =
      chunks.length > 0 ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : null;

    const input: Captured = { path: request.url ?? "", headers: request.headers, body };
    requests.push(input);
    const output = respond(input);
    response.writeHead(output.status ?? 200, {
      "content-type": "application/json",
      ...output.headers,
    });
    response.end(JSON.stringify(output.body));
  }

  const server = createServer((request, response) => {
    void handle(request, response).catch(() => {
      response.writeHead(500);
      response.end();
    });
  });

  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { url, requests, server, close: () => close(server) };
}

export async function close(server: Server) {
  server.closeAllConnections();
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

export function sendInput(
  target: SendInput["target"],
  signal = new AbortController().signal,
): SendInput {
  return {
    deliveryId: "delivery-1",
    requestId: "request-1",
    chunkIndex: 0,
    chunk: {
      text: "hello @everyone <@U123>",
      idempotencyKey: "8db4f4f4-f32c-42a4-a53d-414e348f33a3:0",
      state: null,
    },
    target,
    signal,
  };
}
