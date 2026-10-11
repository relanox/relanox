import { createServer } from "node:http";
import type { IncomingHttpHeaders, IncomingMessage, ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { createCore } from "@relanox/core";
import type { AgentHost, AgentPlugin, ChannelPlugin, Json, ScopedAgentHost } from "@relanox/sdk";
import { createSqliteStorage } from "@relanox/storage-sqlite";

export interface Traffic {
  path: string;
  body: string;
  headers: IncomingHttpHeaders;
}
export async function peer() {
  const traffic: Traffic[] = [];
  let status = 200;
  let output: Json = {};
  let headers: Record<string, string> = {};
  let jwks: Json = {};
  let tokenStatus = 200;
  let tokenBody: Json = { access_token: "oauth-token", token_type: "Bearer" };
  async function receive(incoming: IncomingMessage, response: ServerResponse): Promise<void> {
    const parts: Buffer[] = [];
    for await (const part of incoming) {
      parts.push(Buffer.isBuffer(part) ? part : Buffer.from(String(part)));
    }
    const path = incoming.url ?? "/";
    traffic.push({ path, body: Buffer.concat(parts).toString("utf8"), headers: incoming.headers });
    response.setHeader("content-type", "application/json");
    if (path === "/keys") {
      response.end(JSON.stringify(jwks));
      return;
    }
    if (path === "/token") {
      response.writeHead(tokenStatus);
      response.end(JSON.stringify(tokenBody));
      return;
    }
    response.writeHead(status, headers);
    response.end(JSON.stringify(output));
  }
  const server = createServer((incoming, response) => {
    void receive(incoming, response).catch(() => {
      response.destroy();
    });
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address() as AddressInfo;
  return {
    base: `http://127.0.0.1:${address.port}`,
    traffic,
    respond(code: number, body: Json, responseHeaders: Record<string, string> = {}) {
      status = code;
      output = body;
      headers = responseHeaders;
    },
    token(code: number, body: Json) {
      tokenStatus = code;
      tokenBody = body;
    },
    keys(value: Json) {
      jwks = value;
    },
    async close() {
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
    },
  };
}
export async function harness(
  plugin: ChannelPlugin<unknown>,
  config: Json,
  chat: string,
  sender: string,
  thread?: string,
  filename = ":memory:",
) {
  const storage = createSqliteStorage({ filename, busyTimeoutMs: 5000 });
  await storage.initialize();
  let host: AgentHost | undefined;
  const dispatches: string[] = [];
  const agent: AgentPlugin = {
    id: "agent-dot",
    sdkMajor: 1,
    runtime: "node",
    kind: "agent",
    agent: "dot",
    validateConfig(value) {
      return value as Json;
    },
    async setup(value) {
      host = value;
    },
    async dispatch(input) {
      dispatches.push(input.request.text);
      return { status: "accepted" };
    },
  };
  const core = await createCore({
    storage,
    channels: new Map([["business", plugin]]),
    agents: new Map([["dot", agent]]),
    config: {
      accounts: [{ id: "business", channel: plugin.channel, config, allowedSenders: [sender] }],
      endpoints: [{ id: "agent", agent: "dot", config: {}, dispatchMode: "push" }],
      bindings: [
        {
          accountId: "business",
          chatId: chat,
          ...(thread ? { threadId: thread } : {}),
          endpointId: "agent",
        },
      ],
      storage: { plugin: "sqlite", config: {} },
      observability: { plugin: "none", config: {} },
    },
  });
  function principal(): ScopedAgentHost {
    if (!host) {
      throw new Error("Agent not installed");
    }
    return host.forPrincipal({ subject: "local-agent", endpointIds: ["agent"] });
  }
  async function complete(text = "answer") {
    await core.processDue();
    const scoped = principal();
    const pending = await scoped.listPending(10);
    const item = pending[0];
    if (!item) {
      throw new Error("No pending inbound");
    }
    const claim = await scoped.claim(item.requestId, "local-attempt");
    if (claim.status !== "claimed") {
      throw new Error("Claim failed");
    }
    const completion = await scoped.complete({
      requestId: item.requestId,
      claimToken: claim.claimToken,
      resultId: "local-result",
      text,
    });
    if (completion.status !== "completed") {
      throw new Error("Completion failed");
    }
    await core.processDue();
    return { request: item, delivery: await storage.getOutbound(completion.deliveryId) };
  }
  return {
    core,
    storage,
    dispatches,
    complete,
    async close() {
      await storage.close();
    },
  };
}
