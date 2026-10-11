import { randomUUID } from "node:crypto";
import { createConnection } from "node:net";
import type { Socket } from "node:net";
import { connect as connectTls } from "node:tls";
import type {
  AccountConfig,
  ChannelHost,
  ChannelPlugin,
  SendInput,
  SendResult,
} from "@relanox/sdk";
import { validateConfig, nicknameSchema } from "./config.js";
import type { IrcConfig } from "./config.js";
import { delay, diagnose, ingest, secret, stopTask } from "./protocol.js";
import { recipientSchema, targetSchema } from "./schemas.js";
import { foldNick, parseMessage, wireLine } from "./wire.js";
import type { IrcMessage } from "./wire.js";

const authenticationFailures = new Set(["904", "905", "906", "907", "433", "ERROR"]);

function incomingText(message: IrcMessage, ownNick: string) {
  const sender = message.prefix?.split("!")[0];
  const destination = message.params[0];
  const text = message.params[1];
  if (
    !sender ||
    !message.prefix?.includes("!") ||
    !destination ||
    !text ||
    foldNick(sender) === foldNick(ownNick)
  ) {
    return null;
  }
  return { sender, destination, text };
}
function receivedAt(message: IrcMessage): number {
  const timestamp = Date.parse(message.tags.time ?? "");
  return Number.isFinite(timestamp) && timestamp >= 0 ? timestamp : Date.now();
}

export function createIrcChannel(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): ChannelPlugin<IrcConfig> {
  let runtime: { host: ChannelHost; account: AccountConfig; config: IrcConfig } | undefined;
  let task: Promise<void> | undefined;
  let controller: AbortController | undefined;
  let socket: Socket | undefined;
  let ready = false;
  let nick = "";
  function configured() {
    if (!runtime) {
      throw new Error("not_setup");
    }
    return runtime;
  }
  function write(current: Socket, value: string): void {
    current.write(wireLine(value));
  }
  async function receive(message: IrcMessage): Promise<void> {
    const { host, account, config } = configured();
    const incoming = incomingText(message, nick);
    if (!incoming) {
      return;
    }
    const { sender, destination, text } = incoming;
    if (text.startsWith("\u0001")) {
      diagnose(host, "ctcp_unsupported");
      return;
    }
    const channel = config.channels.find((value) => foldNick(value) === foldNick(destination));
    if (!channel && foldNick(destination) !== foldNick(nick)) {
      return;
    }
    const stableAccount = message.tags.account;
    const authenticated =
      typeof stableAccount === "string" && stableAccount.length > 0 && stableAccount !== "*";
    if (!authenticated && !config.allowNickFallback) {
      diagnose(host, "account_identity_required");
      return;
    }
    if (!authenticated) {
      diagnose(host, "nick_identity_fallback");
    }
    const senderId = authenticated ? `account:${stableAccount}` : `nick:${foldNick(sender)}`;
    const recipient = channel ?? sender;
    recipientSchema.parse(recipient);
    const eventId = message.tags.msgid;
    await ingest(host, {
      source: {
        channel: "irc",
        accountId: account.id,
        eventId: eventId?.length ? eventId : randomUUID(),
      },
      senderId,
      text,
      receivedAt: receivedAt(message),
      target: {
        channel: "irc",
        accountId: account.id,
        chatId: channel ?? `dm:${foldNick(sender)}`,
        ...(message.tags.msgid ? { replyToId: message.tags.msgid } : {}),
        data: { recipient, server: config.server, port: config.port, tls: config.tls },
      },
      context: null,
    });
  }
  function negotiate(current: Socket, message: IrcMessage, offered: Set<string>): void {
    const { config } = configured();
    const subcommand = message.params[1];
    const capabilities = message.params.at(-1)?.split(" ") ?? [];
    if (subcommand === "LS") {
      for (const capability of capabilities) {
        offered.add(capability.split("=")[0] ?? capability);
      }
      if (message.params[2] === "*") {
        return;
      }
      if (config.sasl && !offered.has("sasl")) {
        throw new Error("sasl_unavailable");
      }
      const requested = [
        "account-tag",
        "server-time",
        "message-tags",
        ...(config.sasl ? ["sasl"] : []),
      ].filter((capability) => offered.has(capability));
      write(current, requested.length > 0 ? `CAP REQ :${requested.join(" ")}` : "CAP END");
      return;
    }
    if (subcommand === "ACK") {
      write(current, config.sasl ? "AUTHENTICATE PLAIN" : "CAP END");
    }
    if (subcommand === "NAK") {
      if (config.sasl) {
        throw new Error("sasl_rejected");
      }
      write(current, "CAP END");
    }
  }
  function authenticate(current: Socket): void {
    const { config } = configured();
    if (!config.sasl) {
      throw new Error("unexpected_sasl");
    }
    const password = secret(config.sasl.password, environment);
    if (password.includes("\0")) {
      throw new Error("invalid_secret");
    }
    const payload = Buffer.from(`\0${config.sasl.username}\0${password}`).toString("base64");
    if (payload.length > 4096) {
      throw new Error("sasl_secret_too_large");
    }
    for (let offset = 0; offset < payload.length; offset += 400) {
      write(current, `AUTHENTICATE ${payload.slice(offset, offset + 400)}`);
    }
    if (payload.length % 400 === 0) {
      write(current, "AUTHENTICATE +");
    }
  }
  async function handle(current: Socket, message: IrcMessage, offered: Set<string>): Promise<void> {
    const { host, config } = configured();
    if (authenticationFailures.has(message.command)) {
      throw new Error("registration_or_connection_failed");
    }
    switch (message.command) {
      case "PING": {
        write(current, `PONG :${message.params.at(-1) ?? ""}`);
        return;
      }
      case "CAP": {
        negotiate(current, message, offered);
        return;
      }
      case "AUTHENTICATE": {
        if (message.params[0] === "+") {
          authenticate(current);
        }
        return;
      }
      case "903": {
        write(current, "CAP END");
        return;
      }
      case "001": {
        nick = message.params[0] ?? config.nick;
        ready = true;
        host.connection("connected");
        for (const channel of config.channels) {
          write(current, `JOIN ${channel}`);
        }
        return;
      }
      case "NICK": {
        if (foldNick(message.prefix?.split("!")[0] ?? "") === foldNick(nick)) {
          nick = nicknameSchema.parse(message.params[0]);
        }
        return;
      }
      case "PRIVMSG": {
        if (ready) {
          await receive(message);
        }
        break;
      }
      default: {
        break;
      }
    }
  }
  async function connect(signal: AbortSignal): Promise<void> {
    const { host, config } = configured();
    ready = false;
    nick = config.nick;
    const current: Socket = config.tls
      ? connectTls({
          host: config.server,
          port: config.port,
          servername: config.server,
          rejectUnauthorized: true,
        })
      : createConnection({ host: config.server, port: config.port });
    socket = current;
    current.setEncoding("utf8");
    current.setTimeout(120_000, () => current.destroy());
    const abort = () => current.destroy();
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) {
      abort();
    }
    const registration = setTimeout(() => {
      if (!ready) {
        current.destroy();
      }
    }, config.timeoutMs);
    const offered = new Set<string>();
    let buffer = "";
    let queued = 0;
    let pending = Promise.resolve();
    const queueLine = (line: string) => {
      if (queued >= 100) {
        current.destroy();
        return;
      }
      queued += 1;
      pending = pending
        .then(() => handle(current, parseMessage(line), offered))
        .catch(() => {
          diagnose(host, "receive_failed");
          current.destroy();
        })
        .finally(() => {
          queued -= 1;
        });
    };
    current.once(config.tls ? "secureConnect" : "connect", () => {
      try {
        if (config.password) {
          write(current, `PASS ${secret(config.password, environment)}`);
        }
        write(current, "CAP LS 302");
        write(current, `NICK ${config.nick}`);
        write(current, `USER ${config.nick} 0 * :Relanox`);
      } catch {
        diagnose(host, "registration_failed");
        current.destroy();
      }
    });
    current.on("data", (data: string) => {
      buffer += data;
      if (buffer.length > 16_384 || queued >= 100) {
        current.destroy();
        return;
      }
      const lines = buffer.split("\r\n");
      buffer = lines.pop() ?? "";
      lines.forEach(queueLine);
    });
    await new Promise<void>((resolve) => {
      current.once("close", () => {
        resolve();
      });
      current.on("error", () => {
        current.destroy();
        resolve();
      });
    });
    clearTimeout(registration);
    signal.removeEventListener("abort", abort);
    await pending;
    ready = false;
    host.connection("disconnected");
  }
  async function loop(signal: AbortSignal): Promise<void> {
    const { host, config } = configured();
    while (!signal.aborted) {
      try {
        await connect(signal);
      } catch {
        diagnose(host, "connection_failed");
        host.connection("degraded");
      }
      await delay(config.reconnectMs, signal);
    }
  }
  async function send(input: SendInput): Promise<SendResult> {
    const { account, config } = configured();
    const target = targetSchema.safeParse(input.target.data);
    if (
      input.target.channel !== "irc" ||
      input.target.accountId !== account.id ||
      !target.success ||
      target.data.server !== config.server ||
      target.data.port !== config.port ||
      target.data.tls !== config.tls
    ) {
      return { status: "rejected", errorCode: "target_mismatch" };
    }
    let line: string;
    try {
      const text = input.chunk.text.replaceAll(/\r\n|[\r\n]/gu, " ");
      line = wireLine(`PRIVMSG ${target.data.recipient} :${text}`);
    } catch {
      return { status: "rejected", errorCode: "invalid_irc_text" };
    }
    const current = socket;
    if (!ready || !current || current.destroyed || input.signal.aborted) {
      return { status: "retryable", errorCode: "not_connected", retryAfterMs: 1000 };
    }
    return new Promise<SendResult>((resolve) => {
      const unknown = () => {
        resolve({ status: "unknown", errorCode: "send_outcome_unknown" });
      };
      input.signal.addEventListener("abort", unknown, { once: true });
      current.once("close", unknown);
      current.write(line, (error) => {
        input.signal.removeEventListener("abort", unknown);
        current.removeListener("close", unknown);
        if (error || current.destroyed || input.signal.aborted) {
          unknown();
          return;
        }
        resolve({ status: "sent", receipt: { data: { acknowledgement: "socket_write" } } });
      });
    });
  }
  return {
    id: "channel-irc",
    sdkMajor: 1,
    runtime: "node",
    kind: "channel",
    channel: "irc",
    capabilities: {
      receive: true,
      transport: "connection",
      maxTextLength: 400,
      lengthUnit: "utf8",
      idempotentSend: false,
      media: { receive: [], send: [] },
    },
    validateConfig,
    async setup(host, account, config) {
      if (runtime) {
        throw new Error("already_setup");
      }
      runtime = { host, account, config };
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
      socket?.destroy();
      runtime?.host.connection("disconnected");
      await stopTask(task);
    },
    send,
  };
}
