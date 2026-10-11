export type StandardConfig = {
  readonly logs: boolean
  readonly level: 'debug' | 'info' | 'warn' | 'error'
  readonly metrics: boolean
  readonly processMetrics: boolean
  readonly logBufferBytes: number
  readonly lifecycleTimeoutMs: number
  readonly tracing?: {
    readonly endpoint: string
    readonly sampleRatio: number
    readonly maxQueueSize: number
    readonly maxExportBatchSize: number
    readonly scheduledDelayMs: number
    readonly exportTimeoutMs: number
  }
}

function readConfigObject(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('invalid observability configuration')
  }
  return value as Record<string, unknown>
}

function rejectUnknownConfigFields(
  value: Record<string, unknown>,
  allowed: readonly string[]
): void {
  if (Object.keys(value).some((key) => !allowed.includes(key))) {
    throw new Error('unknown observability configuration field')
  }
}

function readNumericConfig(
  value: unknown,
  fallback: number,
  min: number,
  max: number,
  integer = true
): number {
  const result = value === undefined ? fallback : value
  if (
    typeof result !== 'number' ||
    !Number.isFinite(result) ||
    result < min ||
    result > max ||
    (integer && !Number.isInteger(result))
  ) {
    throw new Error('invalid observability numeric configuration')
  }
  return result
}

function readBooleanConfig(value: unknown, fallback: boolean): boolean {
  if (value === undefined) {
    return fallback
  }
  if (typeof value !== 'boolean') {
    throw new TypeError('invalid observability boolean configuration')
  }
  return value
}

export function validateStandardConfig(input: unknown): StandardConfig {
  const raw = readConfigObject(input)
  rejectUnknownConfigFields(raw, [
    'logs',
    'level',
    'metrics',
    'processMetrics',
    'logBufferBytes',
    'lifecycleTimeoutMs',
    'tracing'
  ])
  const level = raw.level ?? 'info'
  if (
    level !== 'debug' &&
    level !== 'info' &&
    level !== 'warn' &&
    level !== 'error'
  ) {
    throw new Error('invalid log level')
  }
  let tracing: StandardConfig['tracing']
  if (raw.tracing !== undefined) {
    const value = readConfigObject(raw.tracing)
    rejectUnknownConfigFields(value, [
      'endpoint',
      'sampleRatio',
      'maxQueueSize',
      'maxExportBatchSize',
      'scheduledDelayMs',
      'exportTimeoutMs'
    ])
    if (typeof value.endpoint !== 'string') {
      throw new TypeError('tracing requires explicit endpoint')
    }
    const url = new URL(value.endpoint)
    if (
      !['http:', 'https:'].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    ) {
      throw new Error('invalid tracing endpoint')
    }
    const maxQueueSize = readNumericConfig(value.maxQueueSize, 512, 1, 4096)
    tracing = {
      endpoint: url.href,
      sampleRatio: readNumericConfig(value.sampleRatio, 0.1, 0, 1, false),
      maxQueueSize,
      maxExportBatchSize: readNumericConfig(
        value.maxExportBatchSize,
        Math.min(128, maxQueueSize),
        1,
        maxQueueSize
      ),
      scheduledDelayMs: readNumericConfig(
        value.scheduledDelayMs,
        1000,
        100,
        10_000
      ),
      exportTimeoutMs: readNumericConfig(
        value.exportTimeoutMs,
        2000,
        100,
        10_000
      )
    }
  }
  return {
    logs: readBooleanConfig(raw.logs, true),
    level,
    metrics: readBooleanConfig(raw.metrics, true),
    processMetrics: readBooleanConfig(raw.processMetrics, true),
    logBufferBytes: readNumericConfig(
      raw.logBufferBytes,
      65_536,
      1024,
      1_048_576
    ),
    lifecycleTimeoutMs: readNumericConfig(
      raw.lifecycleTimeoutMs,
      3000,
      100,
      10_000
    ),
    ...(tracing ? { tracing } : {})
  }
}
