import type {
  InboundRecord,
  OutboundRecord,
  StatusFilter,
  Storage,
  AttemptStatus,
  DeliveryStatus,
  StorageStats
} from '@relanox/sdk'
import type { AppConfig } from './config.js'
import { deadline } from './deadline.js'
import { openStorage, requireHealthy } from './storage.js'

export async function withStorage<T>(
  config: AppConfig,
  action: (storage: Storage) => Promise<T>
): Promise<T> {
  const storage = await openStorage(config.relay.storage)
  try {
    return await deadline(action(storage), config.server.startupTimeoutMs)
  } finally {
    await deadline(storage.close(), config.server.shutdownTimeoutMs)
  }
}

function requestSummary(
  record: InboundRecord,
  content: boolean
): {
  text?: string
  requestId: string
  endpointId: string
  accountId: string
  version: number
  acceptedAt: number
  dispatch: {
    status: AttemptStatus
    attempts: number
    dueAt: number
  }
  reply: InboundRecord['reply']
  redactedAt: number | undefined
} {
  return {
    requestId: record.snapshot.requestId,
    endpointId: record.snapshot.endpoint.id,
    accountId: record.snapshot.source.accountId,
    version: record.version,
    acceptedAt: record.snapshot.acceptedAt,
    dispatch: {
      status: record.dispatch.status,
      attempts: record.dispatch.attempts,
      dueAt: record.dispatch.dueAt
    },
    reply: record.reply,
    redactedAt: record.redactedAt,
    ...(content ? { text: record.snapshot.text } : {})
  }
}

function deliverySummary(
  record: OutboundRecord,
  content: boolean
): {
  text?: string
  deliveryId: string
  channelId: string
  endpointId: string
  status: DeliveryStatus
  version: number
  currentChunk: number
  reply: OutboundRecord['reply']
  chunkCount: number
  attempts: number
  dueAt: number
} {
  return {
    deliveryId: record.deliveryId,
    channelId: record.channelId,
    endpointId: record.endpoint.id,
    status: record.status,
    version: record.version,
    currentChunk: record.currentChunk,
    reply: record.reply,
    chunkCount: record.chunks.length,
    attempts: record.attempts,
    dueAt: record.dueAt,
    ...(content
      ? { text: record.chunks.map((chunk) => chunk.text).join('') }
      : {})
  }
}

export async function readStatus(
  storage: Storage,
  filter: StatusFilter,
  content: boolean
): Promise<{
  stats: StorageStats
  requests: {
    text?: string
    requestId: string
    endpointId: string
    accountId: string
    version: number
    acceptedAt: number
    dispatch: {
      status: AttemptStatus
      attempts: number
      dueAt: number
    }
    reply: InboundRecord['reply']
    redactedAt: number | undefined
  }[]
  deliveries: {
    text?: string
    deliveryId: string
    channelId: string
    endpointId: string
    status: DeliveryStatus
    version: number
    currentChunk: number
    reply: OutboundRecord['reply']
    chunkCount: number
    attempts: number
    dueAt: number
  }[]
}> {
  await requireHealthy(storage)

  const [stats, requests, deliveries] = await Promise.all([
    storage.getStats(),
    storage.listInbound(filter),
    storage.listOutbound(filter)
  ])

  return {
    stats,
    requests: requests.map((record) => requestSummary(record, content)),
    deliveries: deliveries.map((record) => deliverySummary(record, content))
  }
}

export function missingSecrets(config: AppConfig): string[] {
  const missing = new Set<string>()

  const visit = (input: unknown): void => {
    if (Array.isArray(input)) {
      for (const item of input) {
        visit(item)
      }
      return
    }
    if (input === null || typeof input !== 'object') {
      return
    }
    const fields = Object.entries(input)
    if (fields.length === 1 && fields[0]?.[0] === 'env') {
      const name = fields[0][1] as unknown
      if (typeof name === 'string' && !process.env[name]) {
        missing.add(name)
      }
      return
    }
    for (const [, value] of fields) {
      visit(value)
    }
  }

  visit(config)
  return [...missing].toSorted()
}

export async function probeManagement(
  input: string,
  timeoutMs: number
): Promise<{ ready: boolean }> {
  const url = new URL(input)
  if (
    url.protocol !== 'http:' ||
    !['127.0.0.1', '[::1]'].includes(url.hostname) ||
    url.username ||
    url.password ||
    url.pathname !== '/' ||
    url.search ||
    url.hash
  ) {
    throw new Error('invalid_management_url')
  }

  const response = await fetch(new URL('/health/ready', url), {
    signal: AbortSignal.timeout(timeoutMs),
    redirect: 'error'
  })

  return { ready: response.ok }
}
