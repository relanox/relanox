# 开发与维护

使用 Node 26.11.1 和 packageManager 指定的 pnpm。安装后先构建，再执行类型检查和类型感知 lint；workspace exports 指向编译后的声明文件。

```sh
pnpm install --frozen-lockfile
pnpm build
pnpm check
```

pnpm check 执行格式检查、Oxlint、类型检查和 Vitest。真实 PostgreSQL 测试需要 RELANOX_TEST_POSTGRES_URL 指向可创建/删除 schema 的一次性数据库。测试创建独立 schema 并清理；未提供变量时跳过。Linux CI 提供 PostgreSQL，Windows CI 执行 SQLite 与本地协议测试，不需要生产数据库或真实渠道凭据。

```sh
# POSIX；PowerShell 使用 $env:RELANOX_TEST_POSTGRES_URL。
RELANOX_TEST_POSTGRES_URL=postgresql://relanox:password@127.0.0.1:5432/relanox_test pnpm test
```

镜像契约先执行 `docker build -t relanox:test .`，再为 Vitest 设置 RELANOX_TEST_CONTAINER_IMAGE=relanox:test。测试运行最终生产镜像，覆盖自动 schema 初始化、就绪和重启。CI 用 Buildx 构建并加载镜像，验证 Compose；本地跳过不能证明数据库或镜像通过。

CI 在 master push、PR 和手动触发中独立运行构建/质量、Linux/Windows 测试、生产容器任务，均安装 frozen lockfile。缓存不替代验证。Actions 与镜像固定 commit/digest，由 Dependabot 提交更新；workflow 使用只读 token，不保留 checkout 凭据，取消同分支被替代运行。验证镜像不自动发布。

## 边界

组件职责见 [架构](architecture.md)。修改边界前阅读 [架构](architecture.md)、[SDK](reference/sdk.md)、[Core](reference/core.md) 和对应协议指南。渠道每账号一实例/命名空间，Agent 每 kind 一实例/每 endpoint 鉴权。环境密钥在使用时解析，不进入持久目标、快照、日志和工具结果。

## 变更与测试

实现任务使用 `.worktree/` 下的新分支/工作树。子 Agent 只修改分配的文件范围并提交；根任务评审、集成 master、推送并移除自己完成的工作树。不要删除其他任务 checkout；依赖任务在前置提交落地后开始。

每次提交前检查近期 git log 并匹配现有风格。prepare 安装跟踪的 pre-commit hook。显式运行 pnpm format，hook 只检查，不静默修改 index，拒绝部分暂存。提交前运行 pnpm lint、pnpm typecheck 与相关 Vitest，不绕过 hook。

新增/修改测试前在 PR 说明：保护什么可观察行为、什么可信回归会失败、现有覆盖为何不足、是否需要无生产调用者的 seam。缺少答案时不添加测试，不提交任务专用报告。拒绝无断言、自比较、用被测代码计算期望、mock 实现被断言业务、源码 grep 和敏感于重构的结构断言。

使用真实存储和外部 HTTP/socket 协议对端。对端只能响应外部协议，不能实现 Relanox 路由、授权、持久化或重试。完整转发测试经过生产入口、Agent 鉴权/领取/完成与外发传输，不能拼接 mock 业务函数。恢复测试使用真实存储；DI 必须有生产用途。保护公共 API、协议、配置、迁移、安全与发布契约，不因慢或静态删除有意义测试。

依赖版本固定并更新 lockfile，审查安装脚本与许可证，运行图变化时更新 production notices。参考 checkout 不随产品分发。新协议行为须有主要来源和渠道限制说明，不能用本地测试声称真实账号兼容。pnpm-workspace.yaml 定义依赖发布时间与安装脚本政策；更新依赖时审查精确例外，不全局关闭。

## 代码质量与组织

Prettier 直接使用 `prettier-config-standard` 共享配置，遵循 JavaScript Standard Style 的格式约定：2 空格缩进、80 列、单引号、不加可省略的分号、无尾逗号。这不代表启用完整的 Standard ESLint 规则集。类型感知 Oxlint 在 `oxlint.config.ts` 中加载 `@metamask/oxlint-config-typescript`，统一类型别名、类型导出、函数显式返回类型、类型断言、数组和 Promise 用法。现有项目规则继续叠加，包括参数属性和严格布尔表达式的既有政策。使用根脚本，不增加 formatter 层。CI 先构建 workspace 声明再检查；新测试目录需要可发现的 tsconfig。

Oxlint 同时检查函数、类、接口、类型别名和枚举声明前后的空行，多行 export 与变量声明前后的空行、import 后的空行，以及类方法之间的空行。这些规则通过 Oxlint 的 JavaScript 插件支持运行。Prettier 保留声明间距，但不会补上要求的空行。运行 `pnpm lint:fix` 后再运行 `pnpm format`，分别修复间距和格式；`pnpm lint` 与 pre-commit hook 会拒绝缺少空行的代码，无需单独运行 ESLint 命令。

- config schema 在导入图低于 runtime，校验不得解析密钥、打开资源或初始化状态。
- 按职责组织模块；事务与连接状态机由单一所有者管理，文件长度不是拆分理由。
- SDK 契约显式，内部导入具体兄弟模块，结算保持区分联合类型。
- 名称清晰，SQL 参数、谓词和版本约束能一起审查。
- 复杂度最多 20，嵌套最多 4。unsafe types、未处理 Promise、无用 suppressions 会失败；重构使用已有 API/协议测试。

apps/cli/src/plugins.ts 静态目录有 18 个 import 的窄例外，包含十五渠道、两个 Agent 和 SDK；其余默认十个。其他窄例外由 oxlint.config.ts 定义。不能只为通过检查关闭规则，任何政策改变在 PR 说明。

文档记录当前行为、配置和维护要求。任务状态、审查报告、测试运行结果、注册表快照留在 PR/CI。依赖版本和解析结果属于 manifests 与 lockfile。

## 文档站维护

使用 `pnpm docs:dev`、`pnpm docs:build` 和 `pnpm docs:preview` 维护 VitePress 站点。docs/en 与 docs/zh-CN 保持对应页面，站内链接留在同一语言。GitHub Pages 在 `https://relanox.github.io/` 提供静态文件，无法读取 HTTP Accept-Language；根入口读取浏览器 navigator.languages，精确 zh-CN 选择中文，并保存手动语言偏好。明确语言 URL 保持所选语言。

CSS side-effect import 仅在主题入口使用窄例外。VitePress 内部 Vite 需要 esbuild 0.21.5，它和 workspace esbuild 0.28.2 都使用精确 build-script 允许项；升级站点依赖时保留窄政策。

`relanox/relanox.github.io` 仓库使用自身 GitHub Actions token 构建并发布根站点，每 30 分钟检查本仓库；已发布的源码提交没有变化时跳过构建。维护者也可以手动触发站点仓库的 Documentation 工作流立即发布，无需跨仓库写入凭据。本仓库在文档变化时构建，并在旧项目地址发布逐页跳转，保留查询参数与锚点。
