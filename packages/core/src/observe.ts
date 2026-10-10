import { noopObservability } from "@relanox/sdk";
import type { Observability } from "@relanox/sdk";

export function safeObservability(delegate: Observability = noopObservability): Observability {
  return {
    log(...args) {
      try {
        delegate.log(...args);
      } catch {}
    },
    count(...args) {
      try {
        delegate.count(...args);
      } catch {}
    },
    record(...args) {
      try {
        delegate.record(...args);
      } catch {}
    },
    span(...args) {
      try {
        const span = delegate.span(...args);
        let ended = false;
        return {
          ...(span.context ? { context: span.context } : {}),
          end(outcome) {
            if (ended) {
              return;
            }
            ended = true;
            try {
              span.end(outcome);
            } catch {}
          },
        };
      } catch {
        return { end() {} };
      }
    },
  };
}
