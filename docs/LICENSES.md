# Production dependency licenses

Exact installed production graph; package declarations and distributed license texts, not a legal opinion. Full copyright/license/NOTICE texts are preserved in [THIRD_PARTY_NOTICES.txt](../THIRD_PARTY_NOTICES.txt). Development tools are not shipped in the runtime image.

| Package                                 | Version | Declared license |
| --------------------------------------- | ------- | ---------------- |
| @hono/node-server                       | 2.1.4   | MIT              |
| @modelcontextprotocol/core              | 2.3.1   | Apache-2.0       |
| @modelcontextprotocol/server            | 2.3.1   | Apache-2.0       |
| @opentelemetry/api                      | 1.9.1   | Apache-2.0       |
| @opentelemetry/api-logs                 | 0.223.0 | Apache-2.0       |
| @opentelemetry/context-async-hooks      | 2.12.0  | Apache-2.0       |
| @opentelemetry/core                     | 2.12.0  | Apache-2.0       |
| @opentelemetry/exporter-trace-otlp-http | 0.223.0 | Apache-2.0       |
| @opentelemetry/otlp-exporter-base       | 0.223.0 | Apache-2.0       |
| @opentelemetry/otlp-transformer         | 0.223.0 | Apache-2.0       |
| @opentelemetry/resources                | 2.12.0  | Apache-2.0       |
| @opentelemetry/sdk-logs                 | 0.223.0 | Apache-2.0       |
| @opentelemetry/sdk-metrics              | 2.12.0  | Apache-2.0       |
| @opentelemetry/sdk-trace                | 2.12.0  | Apache-2.0       |
| @opentelemetry/sdk-trace-base           | 2.12.0  | Apache-2.0       |
| @opentelemetry/sdk-trace-node           | 2.12.0  | Apache-2.0       |
| @opentelemetry/semantic-conventions     | 1.43.0  | Apache-2.0       |
| @pinojs/redact                          | 0.4.0   | MIT              |
| @prometheus-io/client                   | 0.16.1  | Apache-2.0       |
| @stablelib/base64                       | 1.0.1   | MIT              |
| atomic-sleep                            | 1.0.0   | MIT              |
| better-sqlite3                          | 13.0.3  | MIT              |
| bintrees                                | 1.0.2   | MIT              |
| commander                               | 15.0.0  | MIT              |
| fast-sha256                             | 1.3.0   | Unlicense        |
| hono                                    | 4.13.13 | MIT              |
| jose                                    | 6.2.12  | MIT              |
| node-addon-api                          | 8.9.2   | MIT              |
| on-exit-leak-free                       | 2.1.2   | MIT              |
| pg                                      | 8.23.1  | MIT              |
| pg-cloudflare                           | 1.4.1   | MIT              |
| pg-connection-string                    | 2.14.1  | MIT              |
| pg-int8                                 | 1.0.1   | ISC              |
| pg-pool                                 | 3.14.0  | MIT              |
| pg-protocol                             | 1.16.1  | MIT              |
| pg-types                                | 2.2.0   | MIT              |
| pgpass                                  | 1.0.5   | MIT              |
| pino                                    | 10.4.0  | MIT              |
| pino-abstract-transport                 | 3.0.0   | MIT              |
| pino-std-serializers                    | 7.1.0   | MIT              |
| postgres-array                          | 2.0.0   | MIT              |
| postgres-bytea                          | 1.0.1   | MIT              |
| postgres-date                           | 1.0.7   | MIT              |
| postgres-interval                       | 1.2.0   | MIT              |
| process-warning                         | 5.1.1   | MIT              |
| quick-format-unescaped                  | 4.0.4   | MIT              |
| real-require                            | 1.0.0   | MIT              |
| safe-stable-stringify                   | 2.5.0   | MIT              |
| sonic-boom                              | 4.2.1   | MIT              |
| split2                                  | 4.2.0   | ISC              |
| standardwebhooks                        | 1.1.1   | MIT              |
| tdigest                                 | 0.1.3   | MIT              |
| thread-stream                           | 4.2.0   | MIT              |
| ws                                      | 8.22.0  | MIT              |
| xtend                                   | 4.0.2   | MIT              |
| zod                                     | 4.6.5   | MIT              |

SQLite embedded by better-sqlite3 is public domain. Two MIT packages embed their license in README.md (pg-types and pgpass). Standard Webhooks omits its library license file from the npm archive; its exact published gitHead supplies the MIT text. The Prometheus client archive omits upstream NOTICE, which is included from its exact published gitHead. Reference repositories are not installed or included in the image.
