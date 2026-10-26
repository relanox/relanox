# Relanox

[English](README.md)

[在线文档](https://relanox.github.io/zh-CN/quickstart.html)

Relanox 将原生消息平台连接到已有的 dot、Grok 和 Muse Agent。Go 服务将接收的消息、
媒体和待发送消息保存到 SQLite 或 PostgreSQL。重启后仍保留消息所属的会话、指定的 Agent、
平台回复上下文和发送状态，包括无法确认是否发送成功的状态。

服务提供腾讯云语音识别、MCP 工具认证、媒体访问控制、结构化日志、Prometheus 指标和
OTLP 链路追踪。流式回复、本地推理与 Serverless
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

Windows 构建为 `bin/relanox.exe`。配置向导保存私有凭据、备份原配置，并打印回调和 MCP
地址。微信扫码后自动保存确认的机器人与用户；Muse 使用已有配对目录。发送消息前，还需要
在外部应用完成回调、权限和 Agent 连接设置。

参阅[快速开始](docs/zh-CN/quickstart.md)、[配置](docs/zh-CN/configuration.md)、
[原生通道](docs/zh-CN/channels.md)、[Agent](docs/zh-CN/agents.md)、
[运维](docs/zh-CN/operations.md)和[部署](docs/zh-CN/deployment.md)。本地协议与集成测试
不代表真实账号兼容性已验证。预编译二进制与容器用法见[部署说明](docs/zh-CN/deployment.md)。

## 开发

先按[开发指南](docs/zh-CN/development.md)安装 `.golangci-lint-version` 中固定的
golangci-lint 版本，放入 `bin/` 或加入 `PATH`。

```sh
git config core.hooksPath .githooks
go run ./tools/check
pnpm install --frozen-lockfile
pnpm docs:build
```

提交检查包括 gofmt、复杂度、嵌套、vet、golangci-lint 与 Go 测试。VitePress 文档构建使用
Node.js 24.14.1，输出 `docs/.vitepress/dist`。
修改前阅读[架构](docs/zh-CN/architecture.md)和[开发指南](docs/zh-CN/development.md)。

Relanox 使用 [MIT 许可](LICENSE)。
