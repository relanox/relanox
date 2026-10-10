import type { SendResult } from "@relanox/sdk";

export class RemoteError extends Error {
  override readonly name = "RemoteError";
  constructor(
    readonly result: Exclude<SendResult, { status: "sent" }>,
    readonly body?: unknown,
  ) {
    super("remote_error");
  }
}
