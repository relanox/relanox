import type { InboundRecord, OutboundRecord, Lease, Storage } from "@relanox/sdk";
import { equal } from "./record-codec.js";

export function matchesInitialResult(
  outbound: OutboundRecord,
  request: InboundRecord,
  input: Parameters<Storage["completeAndEnqueue"]>[0],
): boolean {
  return (
    outbound.requestId === input.requestId &&
    outbound.resultId === input.result.resultId &&
    equal(outbound.target, request.snapshot.target) &&
    outbound.currentChunk === 0 &&
    outbound.receipts.length === 0 &&
    outbound.status === "pending" &&
    outbound.version === 1 &&
    outbound.attempts === 0 &&
    outbound.lease === undefined &&
    outbound.chunks.length > 0 &&
    outbound.chunks.map((chunk) => chunk.text).join("") === input.result.text
  );
}
export const isRequestInScope = (
  r: InboundRecord,
  input: Pick<Parameters<Storage["claimRequest"]>[0], "endpointIds" | "agent">,
) =>
  input.endpointIds.includes(r.snapshot.endpoint.id) && r.snapshot.endpoint.agent === input.agent;
export const isActiveLease = (a: Lease | undefined, b: Lease, now: number) =>
  a !== undefined && equal(a, b) && a.expiresAt > now;
