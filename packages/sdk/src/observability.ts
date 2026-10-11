import type { TraceContext } from "./messages.js";

export type MetricLabels = Readonly<
  Partial<Record<"channel" | "agent" | "plugin" | "operation" | "outcome" | "error_class", string>>
>;

export interface LogFields {
  readonly plugin?: string;
  readonly requestId?: string;
  readonly deliveryId?: string;
  readonly traceId?: string;
  readonly errorCode?: string;
  readonly outcome?: string;
  readonly operation?: string;
}

export interface Span {
  readonly context?: TraceContext;
  end(outcome?: "ok" | "error"): void;
}

export interface Observability {
  log(level: "debug" | "info" | "warn" | "error", event: string, fields?: LogFields): void;
  count(name: string, labels?: MetricLabels, value?: number): void;
  record(name: string, value: number, labels?: MetricLabels): void;
  span(name: string, fields?: LogFields, parent?: TraceContext): Span;
}

export const noopObservability: Observability = Object.freeze({
  log() {},
  count() {},
  record() {},
  span() {
    return { end() {} };
  },
});
