import type {
  AccountConfig,
  Binding,
  ChannelHost,
  CommonHost,
  EndpointConfig,
  IngestInput,
  Observability,
  Storage,
} from "@relanox/sdk";
import type { WorkerConfig } from "../worker/options.js";
import { bindingKey } from "../config/relations.js";
import { CoreError } from "../errors.js";
import { jsonSnapshot } from "../json.js";
import { ingestSchema, boundedText } from "../validation.js";
import { createOperationTracer } from "./tracing.js";

interface ChannelHostOptions {
  readonly account: AccountConfig;
  readonly bindings: ReadonlyMap<string, Binding>;
  readonly endpoints: ReadonlyMap<string, EndpointConfig>;
  readonly common: CommonHost;
  readonly storage: Storage;
  readonly observe: Observability;
  readonly worker: WorkerConfig;
  isAccepting(this: void): boolean;
}

/** Authorizes sender and conversation before persisting the immutable inbound snapshot. */
export function createChannelHost({
  account,
  bindings,
  endpoints,
  common,
  storage,
  observe,
  worker,
  isAccepting,
}: ChannelHostOptions): ChannelHost {
  const traced = createOperationTracer(observe);
  return {
    ...common,
    async ingest(input: IngestInput) {
      if (!isAccepting()) {
        throw new CoreError("not_accepting");
      }
      ingestSchema.parse(input);
      boundedText(input.text, worker.maxTextBytes);
      if (
        input.source.accountId !== account.id ||
        input.target.accountId !== account.id ||
        input.source.channel !== account.channel ||
        input.target.channel !== account.channel
      ) {
        throw new CoreError("account_scope_mismatch");
      }
      if (
        new TextEncoder().encode(JSON.stringify([input.context, input.target.data])).length >
        worker.maxContextBytes
      ) {
        throw new CoreError("context_too_large");
      }
      const binding = bindings.get(
        bindingKey(account.id, input.target.chatId, input.target.threadId),
      );
      if (!binding) {
        throw new CoreError("unbound_conversation");
      }
      if (
        !account.allowedSenders.includes(input.senderId) ||
        (binding.allowedSenders && !binding.allowedSenders.includes(input.senderId))
      ) {
        throw new CoreError("sender_not_allowed");
      }
      const endpoint = endpoints.get(binding.endpointId);
      if (!endpoint) {
        throw new CoreError("unbound_endpoint");
      }
      const receipt = await traced(
        "ingest",
        (trace) =>
          storage.acceptInbound(
            jsonSnapshot({
              ...input,
              ...(trace ? { trace } : {}),
              requestId: crypto.randomUUID(),
              endpoint,
              acceptedAt: Date.now(),
            }),
          ),
        input.trace,
      );
      observe.count("relanox_inbound_total", {
        channel: account.channel,
        outcome: receipt.duplicate ? "duplicate" : "accepted",
      });
      observe.log("info", receipt.duplicate ? "inbound.duplicate" : "inbound.accepted", {
        plugin: "core",
        requestId: receipt.requestId,
        outcome: receipt.duplicate ? "duplicate" : "accepted",
      });
      return receipt;
    },
  };
}
