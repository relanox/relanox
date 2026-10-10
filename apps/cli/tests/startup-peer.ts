import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import type { IncomingMessage, ServerResponse } from "node:http";
import { WebSocketServer } from "ws";
import type { RawData, WebSocket } from "ws";
import { z } from "zod";
import { closeServer, listen } from "../src/listeners.js";
import { deadline } from "../src/deadline.js";

export async function sqliteWriteLock(filename: string) {
  const child = spawn(
    process.execPath,
    [fileURLToPath(new URL("sqlite-lock-peer.mts", import.meta.url)), filename],
    { windowsHide: true, stdio: ["ignore", "ignore", "pipe", "ipc"] },
  );
  let diagnostics = "";
  child.stderr?.on("data", (part: Buffer) => {
    diagnostics += part.toString("utf8");
  });
  let rejectAcquisition: (reason: Error) => void = () => {};
  const acquired = new Promise<void>((resolve, reject) => {
    rejectAcquisition = reject;
    child.once("message", (message: unknown) => {
      if (message === "locked") {
        resolve();
      } else {
        reject(new Error("sqlite_lock_unexpected_message"));
      }
    });
    child.once("error", reject);
  });
  const finished = new Promise<void>((resolve, reject) => {
    child.once("close", (code) => {
      rejectAcquisition(new Error(`sqlite_lock_peer_exited: ${code} ${diagnostics}`));
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`sqlite_lock_peer_failed: ${code} ${diagnostics}`));
      }
    });
  });
  void finished.catch(() => {});
  async function close() {
    if (child.connected) {
      child.send("release", (error) => {
        if (error) {
          child.kill();
        }
      });
    }
    try {
      await deadline(finished, 1000);
    } catch (error) {
      child.kill();
      await deadline(
        finished.catch(() => {}),
        1000,
      );
      throw error;
    }
  }
  try {
    await deadline(acquired, 1000);
  } catch (error) {
    await close().catch(() => {});
    throw error;
  }
  return { close };
}

export function gate() {
  let release = () => {};
  const waiting = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { waiting, release };
}

export async function freeManagementPort(): Promise<number> {
  const server = createServer();
  const url = await listen(server, 0, "127.0.0.1");
  await closeServer(server);
  return Number(new URL(url).port);
}

function wireText(data: RawData): string {
  if (Buffer.isBuffer(data)) {
    return data.toString("utf8");
  }
  if (Array.isArray(data)) {
    return Buffer.concat(data).toString("utf8");
  }
  return Buffer.from(data).toString("utf8");
}

export async function nativePeers() {
  const discovery = gate();
  const discovered = gate();
  const authenticated = gate();
  let origin = "";
  let fastSocket: WebSocket | undefined;
  let closed = false;
  const server = createServer((_request, response) => {
    discovered.release();
    void discovery.waiting.then(() => {
      response.setHeader("content-type", "application/json");
      return response.end(
        JSON.stringify({ endpoint: `${origin.replace("http:", "ws:")}/ding`, ticket: "ticket" }),
      );
    });
  });
  const sockets = new WebSocketServer({ server });
  sockets.on("connection", (socket, incoming) => {
    if (incoming.url !== "/wecom") {
      return;
    }
    fastSocket = socket;
    socket.on("close", () => {
      closed = true;
    });
    socket.on("message", (data) => {
      const frame = z
        .object({ cmd: z.string(), headers: z.object({ req_id: z.string() }) })
        .parse(JSON.parse(wireText(data)) as unknown);
      socket.send(JSON.stringify({ headers: frame.headers, errcode: 0 }));
      if (frame.cmd === "ping") {
        authenticated.release();
      }
    });
  });
  origin = await listen(server, 0, "127.0.0.1");
  return {
    origin,
    discovered: discovered.waiting,
    authenticated: authenticated.waiting,
    releaseDiscovery: discovery.release,
    get fastClosed() {
      return closed;
    },
    publish() {
      if (!fastSocket) {
        throw new Error("wecom_not_connected");
      }
      fastSocket.send(
        JSON.stringify({
          cmd: "aibot_msg_callback",
          headers: { req_id: "source-frame" },
          body: {
            msgid: "startup-event",
            aibotid: "robot",
            chattype: "single",
            from: { userid: "user" },
            msgtype: "text",
            text: { content: "message during startup" },
          },
        }),
      );
    },
    async close() {
      discovery.release();
      for (const socket of sockets.clients) {
        socket.terminate();
      }
      await new Promise<void>((resolve) => {
        sockets.close(() => {
          resolve();
        });
      });
      server.closeAllConnections();
      await closeServer(server);
    },
  };
}

export async function routinePeer() {
  const receipt = gate();
  const received = gate();
  const requests: { path: string; body: string }[] = [];
  async function handle(incoming: IncomingMessage, response: ServerResponse): Promise<void> {
    const chunks: Buffer[] = [];
    for await (const part of incoming) {
      chunks.push(Buffer.isBuffer(part) ? part : Buffer.from(String(part)));
    }
    requests.push({ path: incoming.url ?? "", body: Buffer.concat(chunks).toString("utf8") });
    received.release();
    await receipt.waiting;
    response.writeHead(202);
    response.end();
  }
  const server = createServer((incoming, response) => {
    void handle(incoming, response).catch(() => {
      response.destroy();
    });
  });
  const origin = await listen(server, 0, "127.0.0.1");
  return {
    origin,
    requests,
    received: received.waiting,
    release: receipt.release,
    async close() {
      receipt.release();
      server.closeAllConnections();
      await closeServer(server);
    },
  };
}
