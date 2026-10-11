# 生产依赖许可证

生产依赖许可证概览。精确版本由 package manifests 与 lockfile 定义，本页说明声明许可证和随产品提供的 notices。完整版权/许可证/NOTICE 文字保存在 [THIRD_PARTY_NOTICES.txt](https://github.com/relanox/relanox/blob/master/THIRD_PARTY_NOTICES.txt). 开发工具不随运行镜像分发。

| 依赖包                                  | 声明许可证 |
| --------------------------------------- | ---------- |
| @hono/node-server                       | MIT        |
| @modelcontextprotocol/core              | Apache-2.0 |
| @modelcontextprotocol/server            | Apache-2.0 |
| @opentelemetry/api                      | Apache-2.0 |
| @opentelemetry/api-logs                 | Apache-2.0 |
| @opentelemetry/context-async-hooks      | Apache-2.0 |
| @opentelemetry/core                     | Apache-2.0 |
| @opentelemetry/exporter-trace-otlp-http | Apache-2.0 |
| @opentelemetry/otlp-exporter-base       | Apache-2.0 |
| @opentelemetry/otlp-transformer         | Apache-2.0 |
| @opentelemetry/resources                | Apache-2.0 |
| @opentelemetry/sdk-logs                 | Apache-2.0 |
| @opentelemetry/sdk-metrics              | Apache-2.0 |
| @opentelemetry/sdk-trace                | Apache-2.0 |
| @opentelemetry/sdk-trace-base           | Apache-2.0 |
| @opentelemetry/sdk-trace-node           | Apache-2.0 |
| @opentelemetry/semantic-conventions     | Apache-2.0 |
| @pinojs/redact                          | MIT        |
| @prometheus-io/client                   | Apache-2.0 |
| @stablelib/base64                       | MIT        |
| atomic-sleep                            | MIT        |
| better-sqlite3                          | MIT        |
| bintrees                                | MIT        |
| commander                               | MIT        |
| fast-sha256                             | Unlicense  |
| hono                                    | MIT        |
| jose                                    | MIT        |
| node-addon-api                          | MIT        |
| on-exit-leak-free                       | MIT        |
| pg                                      | MIT        |
| pg-cloudflare                           | MIT        |
| pg-connection-string                    | MIT        |
| pg-int8                                 | ISC        |
| pg-pool                                 | MIT        |
| pg-protocol                             | MIT        |
| pg-types                                | MIT        |
| pgpass                                  | MIT        |
| pino                                    | MIT        |
| pino-abstract-transport                 | MIT        |
| pino-std-serializers                    | MIT        |
| postgres-array                          | MIT        |
| postgres-bytea                          | MIT        |
| postgres-date                           | MIT        |
| postgres-interval                       | MIT        |
| process-warning                         | MIT        |
| quick-format-unescaped                  | MIT        |
| real-require                            | MIT        |
| safe-stable-stringify                   | MIT        |
| sonic-boom                              | MIT        |
| split2                                  | ISC        |
| standardwebhooks                        | MIT        |
| tdigest                                 | MIT        |
| thread-stream                           | MIT        |
| ws                                      | MIT        |
| xtend                                   | MIT        |
| zod                                     | MIT        |

better-sqlite3 内嵌的 SQLite 为公共领域。pg-types 和 pgpass 在 README 中提供 MIT 文字。Standard Webhooks 发布包省略库许可证文件，由精确 published gitHead 提供 MIT 文字；Prometheus client 发布包省略 upstream NOTICE，同样按精确 gitHead 补齐。参考仓库不安装或包含在镜像中。
