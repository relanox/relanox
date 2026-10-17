# Relanox

Relanox 将原生消息平台连接到已有的 dot、Grok 和 Muse Agent。当前代码正在完整
重写为 Go；原 TypeScript 实现、测试、配置和文档保存在
[`ref/typescript`](ref/typescript/README.zh-CN.md)，仅供参考。

目前 Go 基础层包含类型化协议接口、配置加载与有限制的 HTTP 传输。接口声明不代表
集成已经实现。原生通道、可执行程序和持久化运行时正在重建，不应使用归档文档中的
Node.js 启动方式运行 Go 版本。

目标范围为 16 个原生通道、dot/Grok/Muse、SQLite/PostgreSQL、腾讯语音识别、
MCP、媒体、持久化队列、可观测性和命令行。各组件直接在 Go 中组装，不使用插件
机制。流式回复、本地推理和 Serverless 不在范围内。

开发需要 Go 1.26。执行 `git config core.hooksPath .githooks` 配置提交检查，
执行 `go run ./tools/check` 运行格式、静态检查和测试。修改前请阅读
[架构](docs/en/architecture.md)和[开发指南](docs/en/development.md)。
