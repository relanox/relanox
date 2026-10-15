# 许可证

Relanox 使用 [MIT 许可证](https://github.com/relanox/relanox/blob/master/LICENSE)。你可以使用、修改和再分发，包括商业用途；需要保留版权和许可声明。许可证还列出了担保与责任条款。

## 再分发 Relanox

请附上 Relanox 的许可证，以及你随产品分发的依赖的许可声明。仓库中的[补充许可文件](https://github.com/relanox/relanox/tree/master/licenses)随生产依赖提供。各依赖包也在 `node_modules` 中保留自己的许可文件。

包清单和锁文件记录了精确版本。随运行环境提供的依赖声明了以下许可：

| 许可         | 运行依赖示例                                                                                                                                                                                                                                     |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| MIT          | Hono、Pino、better-sqlite3、PostgreSQL 的 `pg` 客户端、Zod、`ws`、Standard Webhooks、Marked、`mime-types`、`mime-db`、`file-type`、`silk-wasm`、`@tencent-connect/qqbot-nodejs`、`eventsource-parser`、`ipaddr.js`、`proper-lockfile`、`retry`。 |
| Apache-2.0   | Model Context Protocol 包、OpenTelemetry 包、Prometheus 客户端、Drizzle ORM、腾讯云 ASR SDK 及其公共包、`google-auth-library`、`simple-oauth2`。                                                                                                 |
| BSD-2-Clause | `entities`。                                                                                                                                                                                                                                     |
| BSD-3-Clause | `buffer-equal-constant-time`、Joi 及其 Hapi 依赖。                                                                                                                                                                                               |
| ISC          | `pg-int8`、`split2`、`ini`、`graceful-fs` 和 `signal-exit`。                                                                                                                                                                                     |
| 0BSD         | `tslib`。                                                                                                                                                                                                                                        |
| Unlicense    | `fast-sha256`。                                                                                                                                                                                                                                  |
| 公有领域     | better-sqlite3 内嵌的 SQLite。                                                                                                                                                                                                                   |

`pg-types`、`pgpass` 和 `data-uri-to-buffer` 的 MIT 文本包含在各自的 README 文件中。Standard Webhooks 的发布包缺少许可文件，Prometheus 客户端的发布包缺少上游 NOTICE；仓库在 `licenses/` 中提供了对应发布提交的补充文件。Marked 的许可文件还保留了原始 Markdown 实现的 BSD-3-Clause 声明。开发工具与生产镜像分开。

Drizzle ORM 0.45.4 声明使用 Apache-2.0，但发布包缺少许可文本。`licenses/drizzle-orm.LICENSE` 提供了对应[发布提交](https://github.com/drizzle-team/drizzle-orm/blob/eab8bedbb65d5429c54e612ddbd88aa23091d398/LICENSE)中的文本。

simple-oauth2 5.1.0 的[发布元数据](https://github.com/lelylan/simple-oauth2/blob/a4a4486b8f4c6d2af82969211052f445c50c1b11/package.json)声明使用 Apache-2.0，但发布包缺少许可文本。`licenses/simple-oauth2.LICENSE` 附上该来源声明和标准 Apache-2.0 文本。其 Hapi 和 Joi 依赖在各自包中保留了 BSD-3-Clause 声明。

如果在再分发前修改了生产依赖，请检查已安装包的许可文件，并随依赖变更更新声明。依赖维护步骤见[贡献指南](../development.md)。

silk-wasm 随包内嵌的编解码器保留 Silk wrapper 的 BSD-2-Clause 和 Skype SILK SDK 的 BSD 声明。对应发布源码的声明，以及内嵌 wav-file-decoder 的 MIT 声明，保存在 licenses/；包本身的 MIT 文件也随依赖分发。

腾讯云 SDK 包自带 Apache-2.0 许可文件。其依赖 `https-proxy-agent` 和 `agent-base` 的 MIT 文本在各自 README 中；`tslib` 同时附带 0BSD 许可及版权声明。`tr46` 0.0.3 声明使用 MIT，但发布包缺少许可文本；`licenses/tr46.LICENSE` 提供上游[补充缺失许可的提交](https://github.com/jsdom/tr46/blob/3a6f29721e7063b9ffd421e461a54beae6170001/LICENSE.md)中的文本。
