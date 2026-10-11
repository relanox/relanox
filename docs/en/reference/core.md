# Message status and recovery

Use this page when a message is delayed, a reply appears more than once, or you need to decide whether to retry a failed send. The [Operations guide](../operations.md) covers the commands used to inspect and recover messages.

## Received, accepted and delivered are different

Relanox first saves an incoming message, then notifies the selected agent. An agent can accept that notification before it has prepared a reply. When the agent sends a reply, Relanox saves it in a separate delivery record.

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

Replies to the same input are sent in the order they were saved. Long text is sent in platform-sized parts, followed by any attachments. An earlier pending or unknown reply holds up later replies to that input. A rejected reply releases later replies.

Messages from separate inputs can proceed independently, including inputs using the same agent.

## How are duplicates avoided?

The same message arriving again is recognized as a duplicate. By default, an agent submitting the same reply again reuses the reply already queued.

If you write an integration, see [Extending Relanox](sdk.md) for sending replies reliably and deliberately sending repeated content.

## Before you recover a message

Inspect the current record and fix the connection, credentials or platform restriction first. For an `unknown` result, check whether the message already arrived. Recovery requires the current record version; unknown recovery additionally requires acknowledging possible duplicates.

A partially sent reply resumes from its unfinished part and retains receipts for earlier parts. Restarting the service resumes saved work, but does not resolve ambiguous remote outcomes by itself. Use [Operations](../operations.md) for recovery commands and [Logs and monitoring](observability.md) to locate the failing stage.
