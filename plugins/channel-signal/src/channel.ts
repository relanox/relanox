import type {
  AccountConfig,
  ChannelHost,
  ChannelPlugin,
  SendInput,
  SendResult,
} from "@relanox/sdk";
import { z } from "zod";
import { validateConfig } from "./config.js";
import type { SignalConfig } from "./config.js";
import {
  delay,
  diagnose,
  httpFailure,
  ingest,
  readJson,
  secret,
  trustedBase,
  stopTask,
} from "./protocol.js";
import { receiveSchema, targetSchema, rpcSchema } from "./schemas.js";
import { consumeEvents } from "./stream.js";

export function createSignalChannel(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): ChannelPlugin<SignalConfig> {
  let runtime:
    | { host: ChannelHost; account: AccountConfig; config: SignalConfig; base: string }
    | undefined;
  let task: Promise<void> | undefined;
  let controller: AbortController | undefined;
  function configured() {
    if (!runtime) {
      throw new Error("not_setup");
    }
    return runtime;
  }
  function headers(): Record<string, string> {
    const { config } = configured();
    return config.authorization ? { Authorization: secret(config.authorization, environment) } : {};
  }
  async function receive(data: string, id: string | undefined): Promise<void> {
    const { host, config, account, base } = configured();
    const incoming = receiveSchema.parse(JSON.parse(data) as unknown);
    const envelope = incoming.envelope;
    const sender = envelope.sourceUuid ?? envelope.sourceNumber ?? envelope.source;
    const message = envelope.dataMessage;
    const self = [envelope.source, envelope.sourceNumber, envelope.sourceUuid].some(
      (value) =>
        value === config.account || (config.selfUuid !== undefined && value === config.selfUuid),
    );
    if ((!incoming.account || incoming.account === config.account) && sender && message && !self) {
      if (!message.message || message.viewOnce) {
        diagnose(host, "nontext_unsupported");
      } else {
        const groupId = message.groupInfo?.groupId;
        const chatId = groupId ? `group:${groupId}` : `direct:${sender}`;
        await ingest(host, {
          source: {
            channel: "signal",
            accountId: account.id,
            eventId: `${sender}:${message.timestamp}:${chatId}`,
          },
          senderId: sender,
          text: message.message,
          receivedAt: envelope.timestamp,
          target: {
            channel: "signal",
            accountId: account.id,
            chatId,
            data: groupId
              ? { kind: "group", groupId, serviceUrl: base, account: config.account }
              : { kind: "direct", recipient: sender, serviceUrl: base, account: config.account },
          },
          context: null,
        });
      }
    }
    if (id !== undefined) {
      const checkpoint = await host.state.get("events");
      const saved = await host.state.compareAndSet({
        key: "events",
        expectedVersion: checkpoint?.version ?? null,
        value: id,
      });
      if (saved.status !== "updated") {
        throw new Error("event_checkpoint_conflict");
      }
    }
  }
  async function connect(signal: AbortSignal): Promise<void> {
    const { host, config, base } = configured();
    const checkpoint = await host.state.get("events");
    const url = new URL(`${base}/api/v1/events`);
    url.searchParams.set("account", config.account);
    const lastId = checkpoint
      ? z
          .string()
          .max(1024)
          .regex(/^[^\r\n\0]*$/u)
          .parse(checkpoint.value)
      : undefined;
    // Periodically reconnect even silent/half-open streams; the daemon's bounded replay is explicit.
    const response = await fetch(url, {
      redirect: "error",
      headers: {
        ...headers(),
        Accept: "text/event-stream",
        ...(lastId ? { "Last-Event-ID": lastId } : {}),
      },
      signal: AbortSignal.any([signal, AbortSignal.timeout(120_000)]),
    });
    if (!response.ok || !response.headers.get("content-type")?.startsWith("text/event-stream")) {
      await response.body?.cancel();
      throw new Error("event_stream_failed");
    }
    host.connection("connected");
    await consumeEvents(response, receive);
  }
  async function loop(signal: AbortSignal): Promise<void> {
    const { host, config } = configured();
    while (!signal.aborted) {
      try {
        await connect(signal);
      } catch {
        if (!signal.aborted) {
          diagnose(host, "receive_failed");
          host.connection("degraded");
        }
      }
      await delay(config.reconnectMs, signal);
    }
    host.connection("disconnected");
  }
  async function send(input: SendInput): Promise<SendResult> {
    const { account, config, base } = configured();
    const target = targetSchema.safeParse(input.target.data);
    if (
      input.target.channel !== "signal" ||
      input.target.accountId !== account.id ||
      !target.success ||
      target.data.serviceUrl !== base ||
      target.data.account !== config.account
    ) {
      return { status: "rejected", errorCode: "target_mismatch" };
    }
    const address =
      target.data.kind === "group"
        ? { groupId: target.data.groupId }
        : { recipient: [target.data.recipient] };
    try {
      const response = await fetch(`${base}/api/v1/rpc`, {
        method: "POST",
        redirect: "error",
        signal: AbortSignal.any([input.signal, AbortSignal.timeout(config.timeoutMs)]),
        headers: { ...headers(), "Content-Type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: input.chunk.idempotencyKey,
          method: "send",
          params: { account: config.account, message: input.chunk.text, ...address },
        }),
      });
      if (!response.ok) {
        await response.body?.cancel();
        return httpFailure(response);
      }
      const rpc = rpcSchema.parse(await readJson(response));
      if (rpc.id !== input.chunk.idempotencyKey || (rpc.error && rpc.result)) {
        return { status: "unknown", errorCode: "rpc_response_mismatch" };
      }
      if (rpc.error) {
        return { status: "unknown", errorCode: "rpc_send_error" };
      }
      if (!rpc.result) {
        return { status: "unknown", errorCode: "rpc_missing_result" };
      }
      if (rpc.result.results?.some((result) => result.type !== "SUCCESS")) {
        // A successful group recipient prevents a top-level RPC error.
        // Replaying the group would duplicate recipients already reached.
        return { status: "unknown", errorCode: "rpc_recipient_failure" };
      }
      return { status: "sent", receipt: { platformMessageId: String(rpc.result.timestamp) } };
    } catch {
      return { status: "unknown", errorCode: "send_outcome_unknown" };
    }
  }
  return {
    id: "channel-signal",
    sdkMajor: 1,
    runtime: "node",
    kind: "channel",
    channel: "signal",
    capabilities: {
      receive: true,
      transport: "connection",
      maxTextLength: 16_000,
      lengthUnit: "utf8",
      idempotentSend: false,
    },
    validateConfig,
    async setup(host, account, config) {
      if (runtime) {
        throw new Error("already_setup");
      }
      runtime = {
        host,
        account,
        config,
        base: trustedBase(config.serviceUrl, config.allowInsecureLocalhost),
      };
    },
    async start(signal) {
      if (task) {
        return;
      }
      configured();
      controller = new AbortController();
      task = loop(AbortSignal.any([signal, controller.signal])).finally(() => {
        task = undefined;
      });
    },
    async stop() {
      controller?.abort();
      runtime?.host.connection("disconnected");
      await stopTask(task);
    },
    send,
  };
}
