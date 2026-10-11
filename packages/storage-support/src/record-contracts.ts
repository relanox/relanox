import type {
  InboundRecord,
  OutboundRecord,
  Lease,
  Storage
} from '@relanox/sdk'
import { equalDurableValues } from './record-codec.js'

export function matchesInitialMessage(
  outbound: OutboundRecord,
  request: InboundRecord,
  input: Parameters<Storage['enqueueMessage']>[0]
): boolean {
  return (
    outbound.requestId === input.requestId &&
    outbound.messageId === input.message.messageId &&
    outbound.createdAt === input.message.createdAt &&
    equalDurableValues(outbound.target, request.snapshot.target) &&
    outbound.currentChunk === 0 &&
    outbound.receipts.length === 0 &&
    outbound.status === 'pending' &&
    outbound.version === 1 &&
    outbound.attempts === 0 &&
    outbound.lease === undefined &&
    outbound.chunks.length > 0 &&
    outbound.chunks.map((chunk) => chunk.text).join('') ===
      input.message.text &&
    outbound.chunks.every(
      (chunk) => chunk.media === undefined || chunk.text === ''
    ) &&
    equalDurableValues(
      outbound.chunks.flatMap((chunk) => (chunk.media ? [chunk.media] : [])),
      input.message.attachments ?? []
    )
  )
}

export const isRequestInScope = (
  record: InboundRecord,
  input: Pick<Parameters<Storage['enqueueMessage']>[0], 'endpointIds' | 'agent'>
): boolean =>
  input.endpointIds.includes(record.snapshot.endpoint.id) &&
  record.snapshot.endpoint.agent === input.agent

export const isActiveLease = (
  storedLease: Lease | undefined,
  attemptLease: Lease,
  now: number
): boolean =>
  storedLease !== undefined &&
  equalDurableValues(storedLease, attemptLease) &&
  storedLease.expiresAt > now
