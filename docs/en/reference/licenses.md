# Production dependency licenses

Production dependency license overview. The package manifests and lockfile define exact versions; this page identifies the declared licenses and shipped notices. Full copyright/license/NOTICE texts are preserved in [THIRD_PARTY_NOTICES.txt](https://github.com/relanox/relanox/blob/master/THIRD_PARTY_NOTICES.txt). Development tools are not shipped in the runtime image.

| Package                                 | Declared license |
| --------------------------------------- | ---------------- |
| @hono/node-server                       | MIT              |
| @modelcontextprotocol/core              | Apache-2.0       |
| @modelcontextprotocol/server            | Apache-2.0       |
| @opentelemetry/api                      | Apache-2.0       |
| @opentelemetry/api-logs                 | Apache-2.0       |
| @opentelemetry/context-async-hooks      | Apache-2.0       |
| @opentelemetry/core                     | Apache-2.0       |
| @opentelemetry/exporter-trace-otlp-http | Apache-2.0       |
| @opentelemetry/otlp-exporter-base       | Apache-2.0       |
| @opentelemetry/otlp-transformer         | Apache-2.0       |
| @opentelemetry/resources                | Apache-2.0       |
| @opentelemetry/sdk-logs                 | Apache-2.0       |
| @opentelemetry/sdk-metrics              | Apache-2.0       |
| @opentelemetry/sdk-trace                | Apache-2.0       |
| @opentelemetry/sdk-trace-base           | Apache-2.0       |
| @opentelemetry/sdk-trace-node           | Apache-2.0       |
| @opentelemetry/semantic-conventions     | Apache-2.0       |
| @pinojs/redact                          | MIT              |
| @prometheus-io/client                   | Apache-2.0       |
| @stablelib/base64                       | MIT              |
| atomic-sleep                            | MIT              |
| better-sqlite3                          | MIT              |
| bintrees                                | MIT              |
| commander                               | MIT              |
| fast-sha256                             | Unlicense        |
| hono                                    | MIT              |
| jose                                    | MIT              |
| node-addon-api                          | MIT              |
| on-exit-leak-free                       | MIT              |
| pg                                      | MIT              |
| pg-cloudflare                           | MIT              |
| pg-connection-string                    | MIT              |
| pg-int8                                 | ISC              |
| pg-pool                                 | MIT              |
| pg-protocol                             | MIT              |
| pg-types                                | MIT              |
| pgpass                                  | MIT              |
| pino                                    | MIT              |
| pino-abstract-transport                 | MIT              |
| pino-std-serializers                    | MIT              |
| postgres-array                          | MIT              |
| postgres-bytea                          | MIT              |
| postgres-date                           | MIT              |
| postgres-interval                       | MIT              |
| process-warning                         | MIT              |
| quick-format-unescaped                  | MIT              |
| real-require                            | MIT              |
| safe-stable-stringify                   | MIT              |
| sonic-boom                              | MIT              |
| split2                                  | ISC              |
| standardwebhooks                        | MIT              |
| tdigest                                 | MIT              |
| thread-stream                           | MIT              |
| ws                                      | MIT              |
| xtend                                   | MIT              |
| zod                                     | MIT              |

SQLite embedded by better-sqlite3 is public domain. Two MIT packages embed their license in README.md (pg-types and pgpass). Standard Webhooks omits its library license file from the npm archive; its exact published gitHead supplies the MIT text. The Prometheus client archive omits upstream NOTICE, which is included from its exact published gitHead. Reference repositories are not installed or included in the image.
