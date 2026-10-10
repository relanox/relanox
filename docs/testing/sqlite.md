# SQLite and shared storage test rationale

Each numbered case below records observable behavior / credible regression / missing coverage / unused production seam. The suite invokes only Storage operations and opens actual databases; no production seam is added.

1. Acceptance snapshot and dedup: a mutated caller cannot change frozen endpoint/target/text and duplicate source returns original ID / retained object references or absent unique source constraint / no previous storage runtime coverage / none.
2. FIFO/scoped claim: second request cannot claim before first, same claim attempt replays token, foreign scope cannot read/claim / omitted FIFO predicate or endpoint scope / acceptance does not claim / none.
3. Atomic final conflict: forged target and global duplicate final leave no outbound or final, matching replay returns original delivery / separate commits or missing invariant validation / claim does not create outbound / none.
4. Lease/send recovery: competing workers lease once, wrong/expired lease cannot settle, partial chunk receipt persists, expired sends stop unknown except safe account / missing fencing or crash state transition / completion does not execute sends / none.
5. Recovery/token revocation: claimed work remains claimed after short lease expiry and explicit requeue invalidates old token / conflated processing token and worker lease / send recovery concerns outbound only / none.
6. Namespace CAS/admin: create/update/delete conflict and namespace filters, aggregate/paginated status / unconditional writes or cross namespace reads / business queue tests do not use protocol state / none.
7. Retention: pending/undelivered survive, delivered text redacts yet dedupe and final equality remain / deleting rows/digest or erasing unknown work / other cases retain content / none.
8. SQLite migration/restart: health rejects unmigrated schema, migration repeats, independent file connections contend atomically, reopened database retains claim and expired lease / auto migration or in-memory correctness / reusable suite exercises single lifecycle / none.

9. Rejected dispatch/admin recovery and retry settlement: rejection blocks FIFO until explicit versioned recovery; retryable preserves chunk identity and returns to due; finalization releases next request / treating rejected as unrecoverable or dispatching later request / lease case only covers sent/unknown / none.
10. Strict JSON and rollback on storage failure: invalid durable values reject without final/outbound partial commit / implicit JSON stringify drops values or insert commits before final validation / invariant rejection is a business conflict rather than driver/serialization exception / none.
11. Failed recovery and retention: scoped failure replay and wrong token denial, stale version recovery denied, failed content may redact / missing terminal checks or accidental requeue of completed / other recovery tests focus claimed/unknown / none.

12. Per-chunk retry budget: successful chunk advancement resets attempts so a long multi-chunk delivery does not exhaust the next chunk budget / cumulative attempts makes successful long responses fail / partial receipt case previously checked only index and receipts / none. The existing partial receipt case now asserts zero attempts after success.

13. Redaction ends request recovery: explicit requeue rejects a failed request whose original input has been intentionally redacted / recovery dispatches empty text after cleanup / earlier recovery and cleanup cases were separate / none. The failed-retention case now tests the boundary directly.

14. Active claim outranks later acceptance ordering: once an endpoint has a claim, a newly accepted request cannot claim or dispatch even if its timestamp is earlier or its same-millisecond ID sorts first; terminal failure releases the new request / FIFO-only comparisons accidentally permit two active requests / prior FIFO cases accepted both requests before claiming and used ascending timestamps / no new seam; shared public Storage contract against real databases.

15. Dispatch ownership survives reordered acceptance: active dispatch leases and stopped unknown/rejected notifications block another request even when new input sorts first, until explicit recovery / checking ordering alone permits overlapping notification effects or bypasses required recovery / active-claim coverage does not exercise the pre-claim notification phase / no new seam; public takeDue, settlement, claim and requeue with actual database state.

16. Accepted notification stays claimable after reordered input: a notification accepted before new same-time input remains the endpoint owner and its claim succeeds / blanket earlier-pending guards deadlock the already notified Agent behind a newly sorted request / previous stopped-notification cases only verify blocking and recovery, not completion of the original / no new seam; public persisted dispatch settlement and claim.
