# Logs and service status

Relanox writes structured JSON logs and can expose Prometheus metrics. Use logs to find the failing stage, metrics to spot growing queues or disconnected channels, and message status to decide whether recovery is needed.

## Enable logs and metrics

Logs and metrics, including process metrics, are enabled by default. Add `observability` inside `relay` only when you need an override. For example, enable debug logging:

```json
{
  "observability": {
    "plugin": "standard",
    "config": {
      "level": "debug"
    }
  }
}
```

Logs go to the service's standard output. View them in the terminal running Relanox, your service manager, or with `docker compose logs -f relanox` for the provided Compose deployment. Change `level` to `debug`, `warn` or `error` if needed, then restart the service.

With the default management settings, check these local addresses:

```sh
curl http://127.0.0.1:8788/health/live
curl http://127.0.0.1:8788/health/ready
curl http://127.0.0.1:8788/metrics
```

`/health/live` checks whether the service is running. `/health/ready` checks database access, whether the service is accepting work and its worker is healthy. A channel can be disconnected while the service is ready; inspect connection metrics as well. The addresses use `server.managementHost` and `server.managementPort`. Keep this listener private. For containers, access it from inside the container or use the documented local administration commands.

## Find why a reply is missing

Look for these log events in the order the message moves through Relanox. Where present, `requestId` connects an input to its later stages and `deliveryId` identifies a saved reply.

| Event                | What to check                                                                 |
| -------------------- | ----------------------------------------------------------------------------- |
| `inbound.rejected`   | Sender allowlist, conversation binding, or unsupported input.                 |
| `dispatch.completed` | Whether the agent accepted the notification; check `outcome` and `errorCode`. |
| `message.queued`     | A reply was saved and is waiting to be sent.                                  |
| `retry.scheduled`    | A temporary failure will be retried.                                          |
| `delivery.completed` | Inspect the send outcome.                                                     |
| `delivery.unknown`   | The remote result is uncertain; check the conversation before retrying.       |
| `connection.changed` | A platform connection changed state.                                          |
| `storage.failed`     | Database access needs attention.                                              |

Error categories such as `authentication`, `authorization`, `rate_limit`, `timeout` and `storage` help locate the problem. Logs omit message bodies, resolved credentials and raw platform error objects. Use the status commands in [Operations](../operations.md) to inspect the affected record; enable message content only when needed and keep the output private.

## Choose useful alerts

Point your Prometheus collector at the private `/metrics` address. Start with these metrics rather than alerting on every error:

| Metric                                          | What it tells you                                                                  |
| ----------------------------------------------- | ---------------------------------------------------------------------------------- |
| `relanox_connection_status`                     | `1` means connected; `0` means disconnected or degraded.                           |
| `relanox_pending`                               | Inputs still waiting for agent notification.                                       |
| `relanox_outbound`                              | Replies not yet delivered, including stopped replies.                              |
| `relanox_unknown`                               | Actions with an uncertain remote result that need review.                          |
| `relanox_oldest_pending_age_seconds`            | Age of the oldest input awaiting notification.                                     |
| `relanox_worker_last_success_timestamp_seconds` | Time of the last successful worker batch. Alert when it stops advancing.           |
| `relanox_storage_stats_stale`                   | `1` means queue counts could not be refreshed.                                     |
| `relanox_telemetry_dropped_total`               | Monitoring data was dropped, for example because the log destination was too slow. |

Compare queue age and worker freshness against the response time you expect from your deployment. When `relanox_storage_stats_stale` is `1`, other queue values may show the last successful snapshot. Counters such as `relanox_delivery_total` and `relanox_retries_total` reset after a process restart; duration metrics use seconds.

## Send traces to a collector

Tracing is optional. Add `tracing` to the standard plugin's `config`, using the collector's full OTLP HTTP trace URL:

```json
{
  "tracing": {
    "endpoint": "http://127.0.0.1:4318/v1/traces",
    "sampleRatio": 0.1
  }
}
```

Replace the address with one reachable from the Relanox process. In a container, `127.0.0.1` refers to that container. `sampleRatio: 0.1` samples 10% of traces. Traces cover local receiving, notification and sending stages; the agent's remote processing time is not traced as one continuous operation.

If your collector needs authentication, the exporter can use `OTEL_EXPORTER_OTLP_HEADERS` or `OTEL_EXPORTER_OTLP_TRACES_HEADERS`. Treat those environment variables as secrets. Collector or logging failures do not stop message processing, but monitoring data can be lost.

To turn monitoring off, set `relay.observability` to `{ "plugin": "none", "config": {} }`. Health and readiness checks remain available.
