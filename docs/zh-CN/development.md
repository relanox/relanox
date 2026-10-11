# 贡献指南

本指南帮助你准备修改、运行检查并提交审核。配置账号和运行服务，请从[快速开始](getting-started.md)入手。

## 准备工作目录

使用 `package.json` 指定的 Node 26.11.1 和 pnpm 12.11.2。每个实现任务都在 `.worktree/` 下创建独立分支和工作目录。例如，在已有仓库中执行：

```sh
git worktree add .worktree/my-change -b my-change
cd .worktree/my-change
pnpm install --frozen-lockfile
pnpm build
pnpm check
```

先构建，再运行类型检查或 lint，因为工作区包使用构建后的类型声明。`pnpm check` 会运行格式检查、lint、类型检查和 Vitest。安装依赖时也会设置仓库跟踪的提交前钩子。

## 保持修改集中

阅读[消息如何到达 Agent](architecture.md)和对应接入的指南。修改 SDK 时，阅读[扩展接入](reference/sdk.md)并查看导出的类型。每次修改围绕明确的可观察行为展开。

凭据保留为环境变量引用，不要放入保存的消息、日志或工具返回值。验证配置时不要建立连接。通过限定权限的插件 host 操作消息和状态。保留代码旁用于解释它的注释。

更新依赖时，保持精确版本、更新锁文件、检查安装脚本和许可；生产依赖变化时更新随附的许可声明。检查 `pnpm-workspace.yaml` 中的局部例外，不要关闭共享的安装策略。

## 选择能发现实际回归的测试

使用 Vitest。添加或修改测试之前，在拉取请求中说明：

- 测试保护什么行为？
- 哪种可信的回归会让它失败？
- 为什么现有测试发现不了这个回归？
- 是否需要没有生产调用者的生产接口？

恢复测试使用真实存储。本地 HTTP 或 socket 对端可以模拟外部平台响应，但不能实现 Relanox 的路由、权限、持久化或重试。测试公开行为，不依赖内部代码结构。新的测试目录需要可发现的 TypeScript 配置，以供类型感知 lint 使用。

运行 PostgreSQL 测试时，将 `RELANOX_TEST_POSTGRES_URL` 设置为可创建和删除 schema 的临时数据库。测试使用隔离 schema，并在结束后清理；未设置时会跳过 PostgreSQL 测试。PowerShell 示例：

```powershell
$env:RELANOX_TEST_POSTGRES_URL = 'postgresql://relanox:password@127.0.0.1:5432/relanox_test'
pnpm test
```

验证生产容器时，先执行 `docker build -t relanox:test .`，在 shell 中设置 `RELANOX_TEST_CONTAINER_IMAGE=relanox:test`，再运行 `pnpm test`。这些测试检查构建镜像的启动、就绪和重启行为。

## 格式化与检查

使用根目录脚本和共享配置。Prettier 负责格式化；Oxlint 还会修复声明和类方法之间要求的空行。

```sh
pnpm lint:fix
pnpm format
pnpm lint
pnpm typecheck
pnpm test
```

复杂度不超过 20，嵌套不超过四层。需要时拆分有明确职责的操作，不要绕过 lint 规则或提交前钩子来合入修改。

## 更新文档

保持英文和简体中文页面一致，链接留在读者选择的语言内。围绕使用者的需求说明配置步骤、预期结果和故障处理。

```sh
pnpm docs:dev
pnpm docs:build
pnpm docs:preview
```

提交文档修改之前运行 `pnpm docs:build`。公开站点为 [relanox.github.io](https://relanox.github.io/)。部署仓库每 30 分钟检查源更新；维护者可以触发其 Documentation 工作流立即更新。

## 提交与审核

每次提交前查看 `git log --oneline -20`，遵循近期提交风格。提交前运行格式化、lint、类型检查和相关 Vitest 测试；修改文档时还要构建文档。暂存一组完整且集中相关的修改，并通过仓库的提交前钩子。不要提交凭据、参考仓库、工作目录或构建输出。

在拉取请求中说明最终行为、测试理由和验证结果。不要把本次任务的状态报告放进仓库。将真实账号验证与本地协议测试分别记录。CI 会检查构建质量、Linux 和 Windows 测试以及生产容器。
