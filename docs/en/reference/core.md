# Message status and recovery

Use this page when a message is delayed, a reply appears more than once, or you need to decide whether to retry a failed send. The [Operations guide](../operations.md) covers the commands used to inspect and recover messages.

## Received, accepted and delivered are different

Relanox first saves an incoming message with its source channel, then notifies the selected Agent. The Agent can accept that notification before preparing an answer. Each send to an authorized channel creates a separate delivery record and does not require a preceding incoming message.

| Status                  | What it means                                                           | What to do                                              |
| ----------------------- | ----------------------------------------------------------------------- | ------------------------------------------------------- |
| Notification `due`      | The input is waiting for a notification attempt or retry.               | Check the agent connection and recent errors.           |
| Notification `accepted` | The agent accepted the notification.                                    | If no reply arrives, check the agent's own service.     |
| Delivery `pending`      | A saved reply has not finished sending.                                 | Check the channel connection and retry errors.          |
| Delivery `sent`         | All parts of the reply have been sent with recorded receipts.           | No recovery is needed.                                  |
| `rejected`              | Processing stopped after a permanent failure or exhausted retry budget. | Fix the cause before explicitly requeueing.             |
| `unknown`               | Relanox cannot confirm whether the remote action happened.              | Check the remote conversation or agent before retrying. |

An agent response of `queued` confirms that a reply was saved. It is not a delivery receipt from the messaging platform.

## What is retried automatically?

Known temporary failures, such as a reported rate limit or a retryable service error, are retried with a delay. By default, there are up to eight attempts; the delay grows from one second up to five minutes unless a retryable response supplies a delay within that range. The standard CLI uses these retry defaults.

If a call times out after it might have reached the remote service, repeating it could send a duplicate. Relanox marks ambiguous outcomes `unknown` and stops automatic attempts.

An accepted agent notification is not automatically repeated just because the agent has not replied. Requeueing an input notifies the agent again; it does not cancel its previous work.

## Why can a later reply be waiting?

Messages to the same channel are sent in the order they were saved. Long text is sent in platform-sized parts, followed by any attachments. An earlier pending delivery holds up later messages to that channel. An unknown delivery also blocks later messages except on QQ, where later replies can continue while the uncertain delivery retains its receipts and requires explicit recovery. Recovering that QQ delivery may send its unfinished parts after newer replies. A rejected delivery releases later messages.

Separate channels can proceed independently, including channels using the same Agent.

## How are duplicates avoided?

The same platform event arriving again is recognized as a duplicate. Each unassociated Agent send without an `idempotencyKey` creates a new message, even when its content matches an earlier send.

For retries, use the same key, channel, text and ordered attachments. Relanox returns the original delivery ID; changing the content with that key returns `conflict`. Use a fresh key for each new send intent. A `queued` result must not be retried with a new key. The Agent can call `relanox_status` with that `deliveryId` to check delivery without sending again.

If you write an integration, see [Extending Relanox](sdk.md) for sending replies reliably and deliberately sending repeated content.

## Before you recover a message

Inspect the current record and fix the connection, credentials or platform restriction first. For an `unknown` result, check whether the message already arrived. Recovery requires the current record version; unknown recovery additionally requires acknowledging possible duplicates.

A partially sent reply resumes from its unfinished part and retains receipts for earlier parts. Restarting the service resumes saved work, but does not resolve ambiguous remote outcomes by itself. Use [Operations](../operations.md) for recovery commands and [Logs and monitoring](observability.md) to locate the failing stage.

## Associate an answer with its incoming message

For an incoming `requestId`, send `reply: { requestId, kind: "final" }` with the complete text and ordered media in one `relanox_send_message` call. Use `kind: "progress"` for interim updates. Replies must use the source channel and its current authorized endpoint; native reply context comes from that incoming message. Proactive sends omit `reply`.

Inspect `relanox_status` with `requestId`, or the `reply` field from `relanox_read_messages`. `awaiting_final` means no final answer is queued. Once queued, `pending`, `sent`, `rejected` and `unknown` describe the final delivery. Only `sent` means all text and media parts were accepted by the platform; it does not prove the recipient read them. Reading, progress updates and accepting an event do not complete a request.

A request can have one final delivery. Identical final retries return that delivery even with a new send key; changed content returns `conflict`. Recover a failed final through its existing delivery ID. Unassociated sends retain their existing key behavior. Retention can remove incoming content; `expired` then means an unanswered tracked request no longer has recoverable content.

## Catch up on unfinished messages

`relanox_read_messages` already supports reading one `requestId` or recent messages. Use `pending: true` to extend that read to retained messages without a fully sent final reply, oldest first. Follow `nextCursor` in subsequent pending calls until absent; a full last page can be followed by an empty page. The default page size is 5, with a maximum of 20. Do not combine `requestId` with pending pagination.

Read `reply.status` before acting: answer `awaiting_final`; inspect the saved `deliveryId` for `pending`, `rejected` or `unknown`. Recheck status before sending. Reads are snapshots and do not claim work, resend events or acknowledge processing. Concurrent final submissions are deduplicated by the request association; differing answers conflict. A later recovery pass starts from the beginning.

Existing deliveries resume through the worker or the existing version-checked CLI `requeue --kind delivery` command. Unknown outcomes still require explicit duplicate-risk acknowledgement. Requeueing a request with an associated final now returns `conflict`; recover its delivery instead. CLI status includes request-to-final and delivery-to-request references.

The existing retention policy still applies: expired content is excluded from pending pages. Query a known request through `relanox_status` to distinguish `expired` from an unfinished final delivery. This recovery is available when dot runs or is invoked manually; it cannot force dot to wake after an accepted event.
