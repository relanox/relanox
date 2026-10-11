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
  record: InboundRecord,
  input: Pick<Parameters<Storage["claimRequest"]>[0], "endpointIds" | "agent">,
) =>
  input.endpointIds.includes(record.snapshot.endpoint.id) &&
  record.snapshot.endpoint.agent === input.agent;
export const isActiveLease = (storedLease: Lease | undefined, attemptLease: Lease, now: number) =>
  storedLease !== undefined && equal(storedLease, attemptLease) && storedLease.expiresAt > now;
