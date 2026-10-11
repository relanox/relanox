import type {
  AccountConfig,
  ChannelHost,
  ChannelPlugin,
  SendInput,
  SendResult,
} from "@relanox/sdk";
import { receiveFiles, uploadFile } from "./media.js";
import { WebSocket } from "ws";
import type { RawData } from "ws";
import type { z } from "zod";
import { validateConfig, validateBaseUrl } from "./config.js";
import type { MattermostConfig } from "./config.js";
import { delay, diagnose, httpFailure, ingest, readJson, secret, stopTask } from "./protocol.js";
import {
  sendResponseSchema,
  postedEventSchema,
  frameSchema,
  postSchema,
  targetSchema,
} from "./schemas.js";

function decodeFrame(bytes: RawData) {
  let buffer: Buffer;
  if (Array.isArray(bytes)) {
    buffer = Buffer.concat(bytes);
  } else if (bytes instanceof ArrayBuffer) {
    buffer = Buffer.from(bytes);
  } else {
    buffer = bytes;
  }
  return frameSchema.parse(JSON.parse(buffer.toString("utf8")) as unknown);
}

export function createMattermostChannel(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): ChannelPlugin<MattermostConfig> {
  let runtime:
    | { host: ChannelHost; account: AccountConfig; config: MattermostConfig; base: string }
    | undefined;

  let task: Promise<void> | undefined;
  let controller: AbortController | undefined;
  let socket: WebSocket | undefined;

  function configured() {
    if (!runtime) {
      throw new Error("not_setup");
    }
    return runtime;
  }

  async function receive(frame: z.infer<typeof frameSchema>, signal: AbortSignal): Promise<void> {
    const { host, account, config, base } = configured();
    if (frame.event !== "posted") {
      return;
    }
    const encoded = postedEventSchema.parse(frame.data);
    const post = postSchema.parse(JSON.parse(encoded.post) as unknown);
    if (post.user_id === config.botUserId) {
      return;
    }
    if (!account.allowedSenders.includes(post.user_id)) {
      diagnose(host, "sender_not_allowed");
      return;
    }
    if (post.type || (!post.message && post.file_ids.length === 0)) {
      diagnose(host, "nontext_unsupported");
      return;
    }

    const attachments = await receiveFiles(
      post.file_ids,
      host,
      config,
      base,
      `Bearer ${secret(config.token, environment)}`,
      signal,
    );

    await ingest(host, {
      source: { channel: "mattermost", accountId: account.id, eventId: post.id },
      senderId: post.user_id,
      text: post.message,
      ...(attachments.length > 0 ? { attachments } : {}),
      receivedAt: post.create_at,
      target: {
        channel: "mattermost",
        accountId: account.id,
        chatId: post.channel_id,
        ...(post.root_id ? { threadId: post.root_id } : {}),
        replyToId: post.id,
        data: { serverUrl: base, botUserId: config.botUserId },
      },
      context: null,
    });
  }

  async function connect(signal: AbortSignal): Promise<void> {
    const { host, base, config } = configured();
    const url = new URL(`${base}/api/v4/websocket`);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    const token = secret(config.token, environment);

    const current = new WebSocket(url, {
      handshakeTimeout: config.timeoutMs,
      maxPayload: 2_097_152,
      followRedirects: false,
    });

    socket = current;
    let authenticated = false;
    let queued = 0;
    let pending = Promise.resolve();
    let lastPong = Date.now();

    const authTimeout = setTimeout(() => {
      diagnose(host, "authentication_timeout");
      current.terminate();
    }, config.timeoutMs);

    const heartbeat = setInterval(() => {
      if (current.readyState !== WebSocket.OPEN) {
        return;
      }
      if (Date.now() - lastPong > 30_000) {
        current.terminate();
        return;
      }
      current.ping();
    }, 10_000);

    const abort = () => {
      current.terminate();
    };

    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) {
      abort();
    }
    current.on("open", () => {
      current.send(JSON.stringify({ seq: 1, action: "authentication_challenge", data: { token } }));
    });
    current.on("pong", () => {
      lastPong = Date.now();
    });

    async function processFrame(frame: z.infer<typeof frameSchema>): Promise<void> {
      if (frame.seq_reply === 1) {
        if (frame.status !== "OK") {
          diagnose(host, "authentication_failed");
          current.terminate();
          return;
        }
        authenticated = true;
        clearTimeout(authTimeout);
        host.connection("connected");
        return;
      }
      if (frame.event === "posted" && !authenticated) {
        throw new Error("unauthenticated_event");
      }
      await receive(frame, signal);
    }

    current.on("message", (bytes, isBinary) => {
      if (isBinary || queued >= 100) {
        diagnose(host, "invalid_frame");
        current.terminate();
        return;
      }
      queued += 1;
      pending = pending
        .then(() => processFrame(decodeFrame(bytes)))
        .catch(() => {
          diagnose(host, "receive_failed");
          host.connection("degraded");
          current.terminate();
        })
        .finally(() => {
          queued -= 1;
        });
    });
    await new Promise<void>((resolve) => {
      current.once("close", () => {
        resolve();
      });
      current.on("error", () => {
        current.terminate();
        resolve();
      });
    });
    clearTimeout(authTimeout);
    clearInterval(heartbeat);
    signal.removeEventListener("abort", abort);
    await pending;
    host.connection("disconnected");
  }

  async function loop(signal: AbortSignal): Promise<void> {
    const { host, config } = configured();
    while (!signal.aborted) {
      try {
        await connect(signal);
      } catch {
        host.connection("degraded");
        diagnose(host, "connection_failed");
      }
      await delay(config.reconnectMs, signal);
    }
  }

  async function send(input: SendInput): Promise<SendResult> {
    const { account, config, base } = configured();
    const destination = targetSchema.safeParse(input.target.data);
    if (
      input.target.channel !== "mattermost" ||
      input.target.accountId !== account.id ||
      !destination.success ||
      destination.data.serverUrl !== base ||
      destination.data.botUserId !== config.botUserId
    ) {
      return { status: "rejected", errorCode: "target_mismatch" };
    }
    try {
      const signal = AbortSignal.any([input.signal, AbortSignal.timeout(config.timeoutMs)]);
      const authorization = `Bearer ${secret(config.token, environment)}`;
      const upload = input.media ? await uploadFile(input, base, authorization, signal) : undefined;
      if (upload && !("fileId" in upload)) {
        return upload;
      }

      const response = await fetch(`${base}/api/v4/posts`, {
        method: "POST",
        redirect: "error",
        signal,
        headers: {
          Authorization: authorization,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          channel_id: input.target.chatId,
          message: input.chunk.text,
          ...(upload && "fileId" in upload ? { file_ids: [upload.fileId] } : {}),
          ...(input.target.threadId ? { root_id: input.target.threadId } : {}),
        }),
      });

      if (!response.ok) {
        await response.body?.cancel();
        return httpFailure(response);
      }
      const post = sendResponseSchema.parse(await readJson(response));
      return { status: "sent", receipt: { platformMessageId: post.id } };
    } catch {
      return { status: "unknown", errorCode: "send_outcome_unknown" };
    }
  }

  return {
    id: "channel-mattermost",
    sdkMajor: 1,
    runtime: "node",
    kind: "channel",
    channel: "mattermost",
    capabilities: {
      receive: true,
      transport: "connection",
      maxTextLength: 16_000,
      lengthUnit: "codepoint",
      idempotentSend: false,
      media: {
        receive: ["image", "audio", "video", "file"],
        send: ["image", "audio", "video", "file"],
      },
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
        base: validateBaseUrl(config.serverUrl, config.allowInsecureLocalhost),
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
      socket?.terminate();
      runtime?.host.connection("disconnected");
      await stopTask(task);
    },
    send,
  };
}
