# CLI test admission

All tests exercise compiled Node entrypoints, real SQLite storage or actual listeners. No fake business implementation or test-only production dependency injection is needed.

## Schema validation and error output

1. `validate` checks plugin schemas and the loopback management boundary without creating a database; command errors never echo secret values, configuration, or provider exceptions.
2. A regression opening storage before validation would leave a file; printing a Zod/JSON parser error would disclose input containing a credential.
3. Core config tests cover relay shape but cannot exercise CLI parsing, output, or resource creation.
4. No unused seam: the compiled executable is the deployment entrypoint.

## Automatic initialization and read-only diagnosis

1. Run initializes an empty database and preserves stored work across restart; doctor/status inspect without creating tables.
2. Missing startup initialization, destructive repeated creation or writes by diagnosis would break this contract.
3. Storage initialization tests do not prove which CLI commands create tables; the real run subprocess exercises the built entrypoint.
4. No unused seam: normal doctor/status/run commands and the public storage API use a real file database.

## Management isolation, ingress, and shutdown

1. Only loopback management serves live/ready/metrics; business HTTP accepts authenticated Telegram events into actual storage, and stop releases both listener ports.
2. Mounting management routes on core business fetch could expose metrics; unawaited listener shutdown could leave the socket occupied; skipping durable ingress could lose an accepted event.
3. Individual core/plugin tests do not create Node listeners or verify the final CLI assembly.
4. `startRuntime` is the same lifecycle used by the production run command; no test-only hooks.

## Partial startup cleanup

1. When management bind fails after business bind, runtime rejects and releases the business listener and database.
2. Registering cleanups after all startup work could leak partially acquired resources.
3. Normal shutdown tests do not execute the startup exception path.
4. No unused seam: failures use an actual occupied TCP port.

## Administrative projections and recovery

1. Status defaults omit text, processing tokens, targets and endpoint secrets; explicit content output adds only text. Requeue checks exact versions and requires explicit unknown-effect acknowledgement.
2. Serializing whole Storage records leaks sensitive fields; dropping recovery options could allow accidental duplicate effects or overwrite a concurrent change.
3. Storage recovery tests cannot prove CLI option parsing or output projection; core status deliberately returns internal records.
4. No unused seam: records are seeded through the public Storage contract, then recovered by the actual executable.
