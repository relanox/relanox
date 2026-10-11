import type { LogFields, MetricLabels } from '@relanox/sdk'
import { normalizeNativeDiagnosticField } from './diagnostics.js'

const channels = [
  'telegram',
  'discord',
  'slack',
  'feishu',
  'wecom',
  'dingtalk',
  'qq',
  'msteams',
  'whatsapp',
  'matrix',
  'googlechat',
  'line',
  'mattermost',
  'signal',
  'irc'
]

const agents = ['dot', 'grok']

export const operations = [
  'ingest',
  'dispatch',
  'enqueue_message',
  'read_media',
  'send',
  'storage',
  'http',
  'worker',
  'connection',
  'recovery',
  'retention',
  'startup',
  'shutdown'
] as const

export const events = [
  'inbound.accepted',
  'inbound.duplicate',
  'inbound.rejected',
  'dispatch.completed',
  'message.queued',
  'media.read',
  'delivery.completed',
  'retry.scheduled',
  'delivery.unknown',
  'connection.changed',
  'worker.completed',
  'storage.failed',
  'recovery.completed',
  'retention.completed',
  'startup.completed',
  'shutdown.completed',
  'operation.failed'
] as const

const outcomes = [
  'ok',
  'error',
  'accepted',
  'duplicate',
  'rejected',
  'retryable',
  'unknown',
  'sent',
  'conflict',
  'unauthorized',
  'connected',
  'disconnected',
  'degraded',
  'stale',
  'not_found',
  'queued',
  'updated'
]

const errorCodes = [
  'timeout',
  'network',
  'authentication',
  'authorization',
  'rate_limit',
  'invalid_input',
  'conflict',
  'storage',
  'unsupported',
  'unavailable',
  'unknown',
  'internal'
]

const plugins = [
  ...channels.map((id) => `channel-${id}`),
  ...agents.map((id) => `agent-${id}`),
  'storage-sqlite',
  'storage-postgres',
  'observability-standard',
  'core',
  'cli'
]

const vocabulary: Record<string, readonly string[]> = {
  channel: channels,
  agent: agents,
  plugin: plugins,
  operation: operations,
  outcome: outcomes,
  error_class: errorCodes
}

export const labelNames = Object.keys(vocabulary)

export const metricDefinitions = {
  relanox_inbound_total: 'counter',
  relanox_dispatch_total: 'counter',
  relanox_delivery_total: 'counter',
  relanox_retries_total: 'counter',
  relanox_http_duration_seconds: 'histogram',
  relanox_storage_duration_seconds: 'histogram',
  relanox_dispatch_duration_seconds: 'histogram',
  relanox_send_duration_seconds: 'histogram',
  relanox_reply_duration_seconds: 'histogram',
  relanox_delivery_duration_seconds: 'histogram',
  relanox_pending: 'gauge',
  relanox_outbound: 'gauge',
  relanox_unknown: 'gauge',
  relanox_oldest_pending_age_seconds: 'gauge',
  relanox_worker_last_success_timestamp_seconds: 'gauge',
  relanox_connection_status: 'gauge',
  relanox_storage_stats_stale: 'gauge'
} as const

export function allowedVocabularyValue(
  value: unknown,
  values: readonly string[]
): string | undefined {
  return typeof value === 'string' && values.includes(value) ? value : undefined
}

export function safeFields(fields: LogFields = {}): Record<string, string> {
  const safe: Record<string, string> = {}
  for (const [key, values] of Object.entries({
    plugin: plugins,
    errorCode: [
      ...errorCodes,
      'call_timeout',
      'retry_budget_exhausted',
      'invalid_chunk_index',
      'plugin_missing',
      'plugin_exception',
      'invalid_plugin_outcome',
      'storage_unavailable',
      'not_accepting',
      'worker_failed'
    ],
    outcome: outcomes,
    operation: operations
  })) {
    const value = allowedVocabularyValue(
      normalizeNativeDiagnosticField(key, fields[key as keyof LogFields]),
      values
    )

    if (value) {
      safe[key] = value
    }
  }
  // Correlation IDs are generated UUIDs; arbitrary caller strings cannot carry message text or secrets.
  for (const key of ['requestId', 'deliveryId'] as const) {
    const value = fields[key]
    if (
      typeof value === 'string' &&
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(
        value
      )
    ) {
      safe[key] = value
    }
  }
  if (
    typeof fields.traceId === 'string' &&
    /^[0-9a-f]{32}$/iu.test(fields.traceId)
  ) {
    safe.traceId = fields.traceId
  }
  return safe
}

export function safeLabels(
  labels: MetricLabels = {}
): Record<string, string> | undefined {
  const safe: Record<string, string> = {}
  // Reject unknown keys/values entirely: mapping hostile identities into combinations still grows cardinality.
  for (const key of Object.keys(labels)) {
    if (!labelNames.includes(key)) {
      return undefined
    }
  }
  for (const key of labelNames) {
    const value = labels[key as keyof MetricLabels]
    if (
      value !== undefined &&
      !allowedVocabularyValue(value, vocabulary[key] ?? [])
    ) {
      return undefined
    }
    safe[key] = value ?? 'none'
  }
  return safe
}
