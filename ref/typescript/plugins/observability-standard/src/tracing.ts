import { ROOT_CONTEXT, SpanStatusCode, trace } from '@opentelemetry/api'
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http'
import { resourceFromAttributes } from '@opentelemetry/resources'
import {
  BatchSpanProcessor,
  TraceIdRatioBasedSampler
} from '@opentelemetry/sdk-trace-base'
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node'
import type { Observability, Span, TraceContext } from '@relanox/sdk'
import type { StandardConfig } from './config.js'
import { allowedVocabularyValue, operations, safeFields } from './fields.js'

export type TracingRuntime = {
  readonly provider: NodeTracerProvider | undefined
  readonly span: Observability['span']
}

export function createTracing(
  config: StandardConfig,
  isClosed: () => boolean,
  isolate: (operation: () => void, signal: string) => void,
  dropped: () => void
): TracingRuntime {
  // Do not register a global provider/context manager: instances and other applications remain independent.
  const provider = config.tracing
    ? new NodeTracerProvider({
        resource: resourceFromAttributes({
          'service.name': 'relanox',
          'service.version': '0.1.0'
        }),
        sampler: new TraceIdRatioBasedSampler(config.tracing.sampleRatio),
        spanLimits: {
          attributeCountLimit: 12,
          attributeValueLengthLimit: 128,
          eventCountLimit: 0,
          linkCountLimit: 1
        },
        spanProcessors: [
          new BatchSpanProcessor(
            new OTLPTraceExporter({
              url: config.tracing.endpoint,
              headers: {},
              timeoutMillis: 2000,
              concurrencyLimit: 1
            }),
            {
              maxQueueSize: 512,
              maxExportBatchSize: 128,
              scheduledDelayMillis: 1000,
              exportTimeoutMillis: 2000
            }
          )
        ]
      })
    : undefined

  const tracer = provider?.getTracer('relanox-observability', '0.1.0')

  const observe: Pick<Observability, 'span'> = {
    span(name, fields, parent): Span {
      if (isClosed() || !tracer || !allowedVocabularyValue(name, operations)) {
        return { end() {} }
      }
      try {
        let context = ROOT_CONTEXT
        if (
          parent &&
          /^00-[0-9a-f]{32}-[0-9a-f]{16}-0[01]$/u.test(parent.traceparent)
        ) {
          const parts = parent.traceparent.split('-')
          const traceId = parts[1]
          const spanId = parts[2]
          if (
            traceId &&
            spanId &&
            !/^0+$/u.test(traceId) &&
            !/^0+$/u.test(spanId)
          ) {
            context = trace.setSpanContext(context, {
              traceId,
              spanId,
              traceFlags: parts[3] === '01' ? 1 : 0,
              isRemote: true
            })
          }
        }

        const span = tracer.startSpan(
          name,
          { attributes: safeFields(fields) },
          context
        )

        const spanContext = span.spanContext()

        const durable: TraceContext = {
          traceparent: `00-${spanContext.traceId}-${spanContext.spanId}-${(spanContext.traceFlags & 1) === 1 ? '01' : '00'}`
        }

        let ended = false
        return {
          context: durable,
          end(outcome = 'ok') {
            if (ended) {
              return
            }
            ended = true
            isolate(() => {
              span.setStatus({
                code:
                  outcome === 'error' ? SpanStatusCode.ERROR : SpanStatusCode.OK
              })
              span.end()
            }, 'traces')
          }
        }
      } catch {
        dropped()
        return { end() {} }
      }
    }
  }

  return { provider, span: observe.span }
}
