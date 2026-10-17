# Relanox

[English](README.md)

Relanox 将原生消息平台连接到已有的 dot、Grok 和 Muse Agent。Go 服务通过
[Ent](https://entgo.io/) 将已接收消息、媒体和出站任务保存到 SQLite 或 PostgreSQL，
在重启后保留原生回复上下文、会话归属和结果不明状态。

组件直接在 Go 中组装，不需要插件加载或安装。腾讯云语音识别、认证 MCP 工具、受限媒体、
结构化日志、Prometheus 指标和 OTLP trace 均由服务提供。流式回复、本地推理与 Serverless
执行不在支持范围。

## 从源码开始

使用 Go 1.27.2：

```sh
go build -trimpath -o bin/relanox ./cmd/relanox
bin/relanox init --config relanox.json --public-url https://relay.example.com
bin/relanox setup --config relanox.json
bin/relanox validate --config relanox.json
bin/relanox run --config relanox.json
```

Windows 构建为 `bin/relanox.exe`。引导保存私有凭据、备份原配置，并打印回调和 MCP
地址。微信扫码自动保存确认的 bot 与用户；Muse 使用已有配对目录。发送消息前，还需要
在外部应用完成回调、权限和 Agent 连接设置。

参阅[快速开始](docs/zh-CN/quickstart.md)、[配置](docs/zh-CN/configuration.md)、
[原生通道](docs/zh-CN/channels.md)、[Agent](docs/zh-CN/agents.md)、
[运维](docs/zh-CN/operations.md)和[部署](docs/zh-CN/deployment.md)。本地协议与集成测试
不代表真实账号兼容性已验证。已有 Release 可能仍是旧 TypeScript 版本；发布 Go 版本前，
请使用当前代码或当前成功 CI 的 Go 产物。

## 开发

```sh
git config core.hooksPath .githooks
go run ./tools/check
go run ./tools/docs
```

门禁检查 gofmt、复杂度、嵌套、vet 与 Go 测试。原生 Go 文档构建器输出 `docs/site`，
不依赖 Node.js。修改前阅读[架构](docs/en/architecture.md)和[开发指南](docs/en/development.md)。
旧 TypeScript 源码与文档保存在 `ref/typescript`，不参与 Go 构建或运行。

Relanox 使用 [MIT 许可](LICENSE)，第三方声明与分发依赖许可见[许可说明](licenses/README.md)。
