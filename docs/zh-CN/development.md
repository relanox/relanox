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

原生插件作为 CLI 的工作区开发依赖提供，`pnpm install --frozen-lockfile` 和 `pnpm build` 保持原有源码流程。CLI 包可以独立打包；生产分发需要安装或组装所用的原生包。支持打包不表示对应版本已经发布到 npm。

需要在正常工作区解析之外开发插件时，先构建，再在测试配置中用 `plugins.load.paths` 指向包目录。相对覆盖路径以该配置文件所在目录为准。覆盖包需要 `relanox` 清单，以及导出 `createPlugin` 的编译入口 `dist/plugin.js`；详见[打包原生插件](reference/sdk.md#打包原生插件)。重复身份或无效覆盖会直接失败，不会使用已安装副本。修改后重新构建并重启。

## 保持修改集中

阅读[消息如何到达 Agent](architecture.md)和对应接入的指南。修改 SDK 时，阅读[扩展接入](reference/sdk.md)并查看导出的类型。每次修改围绕明确的可观察行为展开。

凭据保留为环境变量引用，不要放入保存的消息、日志或工具返回值。验证配置时不要建立连接。通过限定权限的插件 host 操作消息和状态。保留代码旁用于解释它的注释。

更新依赖时，保持精确版本、更新锁文件、检查安装脚本和许可；生产依赖变化时更新随附的许可声明。检查 `pnpm-workspace.yaml` 中的局部例外，不要关闭共享的安装策略。

存储查询使用 Drizzle 的类型化 schema、查询构建器和事务接口。根据 schema 生成迁移，并随存储包分发。运行时代码不手写数据查询或 schema DDL；数据库特有表达式和函数调用保持范围明确并使用参数，保留数据库端的过滤、排序和数量限制。

修改存储 schema 后运行 `pnpm --filter @relanox/storage-sqlite db:generate` 或 `pnpm --filter @relanox/storage-postgres db:generate`，提交前检查生成的迁移。PostgreSQL 通过 `search_path` 支持配置的 schema，表和外键引用应在该 schema 中解析，不能固定指向 `public`。开发阶段修改 schema 时，重新生成初始建表定义和对应快照，不维护旧开发数据库的升级路径。切换 schema 版本时使用新的临时数据库；同一版本的初始化和重启仍保持幂等。

## 选择能发现实际回归的测试

使用 Vitest。添加或修改测试之前，在拉取请求中说明：

- 测试保护什么行为？
- 哪种可信的回归会让它失败？
- 为什么现有测试发现不了这个回归？
- 是否需要没有生产调用者的生产接口？

恢复测试使用真实存储。本地 HTTP 或 socket 对端可以模拟外部平台响应，但不能实现 Relanox 的路由、权限、持久化或重试。测试公开行为，不依赖内部代码结构。新的测试目录需要可发现的 TypeScript 配置，以供类型感知 lint 使用。

外部响应 fixture 应来自平台文档、实际响应记录或经过核对的 SDK 实现，并在 fixture 旁注明来源。区分平台标识、编号、字段类型、可选字段和本地数组位置。参考资料相互矛盾时，先验证响应，再修改约定。照着 Relanox 的假设编写对端，不能证明真实平台兼容。

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

连接配置器是客户端 Vue 组件。`pnpm typecheck` 使用 `vue-tsc` 与固定版本的 `typescript-vue` 编译器别名检查模板；Vue 检查器依赖的 JavaScript 编译器 API 已不再由 TypeScript 7 导出。运行时包仍使用 TypeScript 7。配置器测试将生成的 JSON 交给生产配置校验器检查，不连接真实平台账号。

## 提交与审核

每次提交前查看 `git log --oneline -20`，遵循近期提交风格。提交前运行格式化、lint、类型检查和相关 Vitest 测试；修改文档时还要构建文档。暂存一组完整且集中相关的修改，并通过仓库的提交前钩子。不要提交凭据、参考仓库、工作目录或构建输出。

在拉取请求中说明最终行为、测试理由和验证结果。不要把本次任务的状态报告放进仓库。将真实账号验证与本地协议测试分别记录。CI 会检查构建质量、Linux 和 Windows 测试以及生产容器。
