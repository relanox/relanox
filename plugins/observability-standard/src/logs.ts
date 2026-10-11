import type { Writable } from "node:stream";
import pino from "pino";
import type { Observability } from "@relanox/sdk";
import type { StandardConfig } from "./config.js";
import { nativeEvents } from "./diagnostics.js";
import { events, member, safeFields } from "./fields.js";

export class BoundedLogWriter {
  private queue: string[] = [];
  private bytes = 0;
  private pending = 0;
  private blocked = false;
  private failed = false;
  private closed = false;
  private readonly waiters = new Set<() => void>();
  constructor(
    private readonly destination: Writable,
    private readonly maxBytes: number,
    private readonly dropped: () => void,
  ) {
    destination.on("drain", this.drain);
    destination.on("error", this.error);
  }
  private readonly error = (): void => {
    this.failed = true;
    this.queue = [];
    this.bytes = 0;
    this.wake();
  };
  private readonly drain = (): void => {
    this.blocked = false;
    while (!this.blocked && this.queue.length > 0) {
      const line = this.queue.shift();
      if (line === undefined) {
        break;
      }
      this.bytes -= Buffer.byteLength(line);
      this.write(line);
    }
    if (this.idle()) {
      this.wake();
    }
  };
  private idle(): boolean {
    return !this.blocked && this.queue.length === 0 && this.pending === 0;
  }
  private wake(): void {
    for (const done of this.waiters) {
      done();
    }
  }
  write(line: string): void {
    if (this.closed || this.failed) {
      this.dropped();
      return;
    }
    if (this.blocked) {
      const size = Buffer.byteLength(line);
      if (size > this.maxBytes - this.bytes) {
        this.dropped();
        return;
      }
      this.queue.push(line);
      this.bytes += size;
      return;
    }
    this.pending++;
    try {
      this.blocked = !this.destination.write(line, (error) => {
        this.pending--;
        if (error) {
          this.error();
        } else if (this.idle()) {
          this.wake();
        }
      });
    } catch {
      this.pending--;
      this.error();
      this.dropped();
    }
  }
  async flush(signal: AbortSignal): Promise<void> {
    if (this.failed || this.idle() || signal.aborted) {
      return;
    }
    await new Promise<void>((resolve) => {
      const done = () => {
        this.waiters.delete(done);
        signal.removeEventListener("abort", done);
        resolve();
      };
      this.waiters.add(done);
      signal.addEventListener("abort", done, { once: true });
    });
  }
  close(): void {
    this.closed = true;
    this.queue = [];
    this.bytes = 0;
    this.wake();
    this.destination.removeListener("drain", this.drain);
    this.destination.removeListener("error", this.error);
  }
}

export function createLogs(config: StandardConfig, destination: Writable, dropped: () => void) {
  const writer = new BoundedLogWriter(destination, config.logBufferBytes, dropped);
  const logger = pino(
    {
      level: config.level,
      base: null,
      timestamp: pino.stdTimeFunctions.isoTime,
    },
    {
      write: (line) => {
        writer.write(line);
      },
    },
  );

  const log: Observability["log"] = (level, event, fields) => {
    if (!config.logs || !member(level, ["debug", "info", "warn", "error"])) {
      return;
    }
    logger[level]({
      event: member(nativeEvents.get(event) ?? event, events) ?? "operation.failed",
      ...safeFields(fields),
    });
  };
  return { writer, log };
}
