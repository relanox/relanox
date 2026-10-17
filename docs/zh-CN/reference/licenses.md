# 许可证

Relanox 使用 [MIT 许可证](https://github.com/relanox/relanox/blob/master/LICENSE)。你可以使用、修改和再分发，包括商业用途；需要保留版权和许可声明。许可证还列出了担保与责任条款。

## 再分发 Relanox

请附上 Relanox 的许可证，以及你随产品分发的依赖的许可声明。仓库中的[补充许可文件](https://github.com/relanox/relanox/tree/master/licenses)随生产依赖提供。各依赖包也在 `node_modules` 中保留自己的许可文件。

包清单和锁文件记录了精确版本。随运行环境提供的依赖声明了以下许可：

| 许可          | 运行依赖示例                                                                                                                                                                                       |
| ------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| MIT           | Hono、Pino、better-sqlite3、PostgreSQL 的 `pg` 客户端、Zod、`ws`、Standard Webhooks、Marked、`file-type`、`silk-wasm`、QQ、飞书、Slack、企微和 Teams SDK、发布的 Mattermost 客户端及类型包。       |
| Apache-2.0    | Model Context Protocol 包、OpenTelemetry 包、Prometheus 客户端、Drizzle ORM、腾讯云 ASR SDK、Matrix SDK、LINE SDK、Google Chat API 及认证库、部分阿里云 SDK 包、`muse-client`、`qrcode-terminal`。 |
| BSD-2-Clause  | `entities`。                                                                                                                                                                                       |
| BSD-3-Clause  | `buffer-equal-constant-time`、`protobufjs` 及其 `@protobufjs/*` 辅助包、`qs`、`ieee754` 和 `url-template`（后者的元数据使用简写 `BSD`）。                                                          |
| ISC           | `pg-int8`、`split2`、`ini`、`graceful-fs`、`signal-exit`、`semver` 及部分阿里云包的声明；声明差异见下文。                                                                                          |
| BlueOak-1.0.0 | `sax` 1.6.1，其 `LICENSE.md` 包含完整的 Blue Oak Model License 1.0.0。                                                                                                                             |
| 0BSD          | `tslib`。                                                                                                                                                                                          |
| Unlicense     | `fast-sha256`。                                                                                                                                                                                    |
| 公有领域      | better-sqlite3 内嵌的 SQLite。                                                                                                                                                                     |

`pg-types`、`pgpass`、`data-uri-to-buffer`、`@tokenizer/token`、`http-proxy-agent` 5.0.0 和 `socks-proxy-agent` 6.2.1 的 MIT 文本包含在各自的 README 文件中。Standard Webhooks 的发布包缺少许可文件，Prometheus 客户端的发布包缺少上游 NOTICE；仓库在 `licenses/` 中提供了对应发布提交的补充文件。Marked 的许可文件还保留了原始 Markdown 实现的 BSD-3-Clause 声明。开发工具与生产镜像分开。

Drizzle ORM 0.45.4 声明使用 Apache-2.0，但发布包缺少许可文本。`licenses/drizzle-orm.LICENSE` 提供了对应[发布提交](https://github.com/drizzle-team/drizzle-orm/blob/eab8bedbb65d5429c54e612ddbd88aa23091d398/LICENSE)中的文本。

部分官方 SDK 的发布包缺少独立许可文件。[SDK 补充声明](https://github.com/relanox/relanox/blob/master/licenses/sdk-dependencies.NOTICE)记录了精确包版本、发布声明及文本来源。Teams 2.1.0 系列包和 Google Chat 51.2.0 补充了对应上游版本的许可文件。企微 1.0.7、所列阿里云包、`httpx` 2.3.3 和 `sm3` 1.0.3 则保留发布元数据及 README 的声明，并附上相应标准许可文本。这些标准文本是补充文件，不冒充上游缺失文件，也不推测版权人。

两个阿里云包的发布声明不一致：`@alicloud/openapi-client` 0.4.15 的 `package.json` 声明 ISC，README 声明 Apache-2.0；`@alicloud/tea-typescript` 1.8.0 的 `package.json` 声明 ISC，README 声明 MIT。补充声明保留每处来源并附上双方引用的文本，不据此认定双重授权，也不宣称差异已解决。

发布的 `@mattermost/client` 和 `@mattermost/types` 11.9.0 声明 MIT。对应的[上游许可政策](https://github.com/mattermost/mattermost/blob/583461af10fc9b2aef2871c722fc4376db695832/LICENSE.txt)区分官方编译发行物的 MIT 与 `webapp` 源码的 Apache-2.0。`licenses/mattermost-compiled.LICENSE` 和 `licenses/mattermost-source.LICENSE` 保留两份原始文档。政策中的其他源码条款不代表这些 npm 包声明了相应许可。

如果在再分发前修改了生产依赖，请检查已安装包的许可文件，并随依赖变更更新声明。依赖维护步骤见[贡献指南](../development.md)。

silk-wasm 随包内嵌的编解码器保留 Silk wrapper 的 BSD-2-Clause 和 Skype SILK SDK 的 BSD 声明。对应发布源码的声明，以及内嵌 wav-file-decoder 的 MIT 声明，保存在 licenses/；包本身的 MIT 文件也随依赖分发。

腾讯云 SDK 包自带 Apache-2.0 许可文件。其依赖 `https-proxy-agent` 和 `agent-base` 的 MIT 文本在各自 README 中；`tslib` 同时附带 0BSD 许可及版权声明。`tr46` 0.0.3 声明使用 MIT，但发布包缺少许可文本；`licenses/tr46.LICENSE` 提供上游[补充缺失许可的提交](https://github.com/jsdom/tr46/blob/3a6f29721e7063b9ffd421e461a54beae6170001/LICENSE.md)中的文本。

Muse 适配器使用 Apache-2.0 的 `muse-client` 0.1.0，随包附带原生 gadget 协议的 LICENSE 与 NOTICE。微信二维码显示使用 Apache-2.0 的 `qrcode-terminal` 0.12.0；再分发时保留随包许可证及内嵌二维码编码器中的声明。依赖许可证与 Muse 服务及 Gadget SDK 的访问条款分开。
