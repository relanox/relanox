# Operations audit test rationale

## Asynchronous collector flush and shutdown

1. Observable behavior: `flush` and `shutdown` wait for accepted log writes to finish, including writes below the collector's high-water mark, while respecting the lifecycle deadline. The caller can safely release its collector after shutdown.
2. Credible regression: treating `Writable.write()` returning true as completion resolves lifecycle calls before the asynchronous write callback, losing accepted logs on collector teardown.
3. Coverage gap: existing logging coverage only exercises high-water-mark backpressure and collector failure, not successful asynchronous writes that never emit `drain`.
4. Production seam: no new seam. The public `logDestination` option already supports production-owned collector streams; the test uses an actual Node Writable and controls only its I/O completion.

## Native diagnostic normalization

1. Observable behavior: current native channel events and fixed diagnostic codes produce meaningful documented event/error categories in JSON logs; arbitrary provider text remains excluded.
2. Credible regression: the native plugins emit `channel_*` events, `receive` operations, and fixed codes that the original standard vocabulary silently strips, leaving only an uninformative `operation.failed` record.
3. Coverage gap: existing boundary tests use the documented generic vocabulary and hostile strings but never submit the exact constants emitted by native plugins.
4. Production seam: none. Exercise the public observability facade and real JSON output with current native emitter constants, including unknown prefix lookalikes to protect strict sanitization.
