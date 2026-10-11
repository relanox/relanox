import { WebSocketServer } from "ws";
import type { WebSocket } from "ws";

export async function discordPeer() {
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await new Promise<void>((resolve) => {
    server.once("listening", resolve);
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new TypeError("invalid_gateway_address");
  }
  const url = `ws://127.0.0.1:${address.port}`;
  let active: WebSocket | undefined;
  server.on("connection", (socket) => {
    active = socket;
    socket.send(JSON.stringify({ op: 10, d: { heartbeat_interval: 30_000 } }));
    socket.on("message", (bytes) => {
      if (!Buffer.isBuffer(bytes)) {
        throw new TypeError("unexpected_gateway_bytes");
      }
      const frame: unknown = JSON.parse(bytes.toString("utf8"));
      if (typeof frame === "object" && frame !== null && "op" in frame && frame.op === 2) {
        socket.send(
          JSON.stringify({
            op: 0,
            t: "READY",
            s: 1,
            d: { session_id: "777", resume_gateway_url: url, user: { id: "999" } },
          }),
        );
      }
      if (typeof frame === "object" && frame !== null && "op" in frame && frame.op === 1) {
        socket.send(JSON.stringify({ op: 11 }));
      }
    });
  });
  return {
    url,
    message(data: unknown) {
      if (!active) {
        throw new Error("gateway_not_connected");
      }
      active.send(JSON.stringify({ op: 0, t: "MESSAGE_CREATE", s: 2, d: data }));
    },
    connected: () => active !== undefined,
    close: () =>
      new Promise<void>((resolve, reject) => {
        for (const client of server.clients) {
          client.terminate();
        }
        server.close((error) => {
          if (error) {
            reject(error);
          } else {
            resolve();
          }
        });
      }),
  };
}
