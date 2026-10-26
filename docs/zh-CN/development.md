# 贡献指南

使用 Go 1.27.2。每项实现任务在 `.worktree/` 下使用独立分支和工作树，开始前阅读
[架构说明](architecture.md)与根目录的 [AGENTS.md](https://github.com/relanox/relanox/blob/master/AGENTS.md)。

```sh
git config core.hooksPath .githooks
go run ./tools/check
```

将 `.golangci-lint-version` 指定版本的官方 golangci-lint 安装到被忽略的 `bin/`
目录或 `PATH`，其中 `bin/` 优先。安装方式见[上游说明](https://golangci-lint.run/docs/welcome/install/local/)。
本地与 CI 使用同一版本，linter 的依赖不进入应用的 `go.mod`。

## 实现与检查

提交钩子运行相同的检查：gofmt、复杂度不超过 20、嵌套不超过四层、`go vet ./...`、
golangci-lint 和 `go test ./...`。修改 Go 文件后先运行 `gofmt -w`，不要绕过钩子。
每次提交前检查最近的提交信息并遵循现有风格。生成文件由生成器维护；`nolint` 必须
明确指出规则并说明具体例外。

使用显式构造函数和编译期接口。构造函数离线校验配置并挂载路由，`Start(ctx)` 启动连接
与后台循环后返回，`Close(ctx)` 在关闭期限内停止并等待 worker。context 取消必须传递到 I/O。

原生配置拒绝未知结构字段与无效边界。相对路径以配置文件所在目录为基准。
错误信息不回显凭据；凭据使用环境变量或文件引用，解析后的值不写入持久化快照。

## 测试

使用 Go testing 验证可观察的 API、协议、配置、迁移、安全或发布行为。增加测试前，
明确可信的回归、现有覆盖的缺口以及是否需要仅用于测试的接口，并在 PR 中说明。
外部响应 fixture 需要平台文档、已记录流量或经核实的 SDK 来源。
本地 HTTP/socket 对端只模拟外部协议，不实现 Relanox 的路由、持久化、重试或授权。

## 文档

文档使用 VitePress，提供双语导航、本地搜索、深色模式和连接配置器。Node.js 与 pnpm 仅用于文档工具，
Go 服务运行不依赖它们。使用 Node.js 24.14.1 和 `package.json` 固定的 pnpm 版本：

```sh
pnpm install --frozen-lockfile
pnpm docs:check
pnpm docs:build
pnpm docs:dev
```

构建校验 Vue/TypeScript 和 Markdown 链接，生成 `docs/.vitepress/dist`，并为已有链接生成
跳转页。`docs/local/` 不进入站点。中英文操作文档应与当前原生选项一致。

主仓库文档变更通过 `repository_dispatch` 触发文档仓库发布，没有定时轮询。
`source-commit.txt` 记录实际使用的源码版本。部署排障前，从主工作树读取私有
`docs/local/deployment.md`（如果存在）。

## Ent 与迁移

SQLite 和 PostgreSQL 共用 `internal/storage/ent/schema/records.go`、生成的查询构建器
和事务 API。Ent 生成器版本作为 Go tool 固定在 `go.mod`，现有生成指令启用 `sql/upsert`：

```sh
go generate ./internal/storage/...
git diff --exit-code -- internal/storage/ent
```

schema 变更应一并审查和提交生成代码及 `internal/storage/migrations/sqlite`、
`postgres` 下的迁移。使用 `internal/storage/cmd/migrations` 对空开发数据库生成迁移；
不要手写运行时数据查询或 schema DDL。数据库格式变化需要明确的迁移策略。
