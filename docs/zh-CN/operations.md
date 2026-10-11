# 运维

Relanox 以一个常驻 Node 26 进程运行，使用一个权威 SQLite 或 PostgreSQL 数据库。升级前备份配置和数据库。

## 容器部署

Dockerfile 构建 workspace，只部署 CLI 生产依赖，以 UID 1000 运行，并使用可写 `/data` volume。构建与运行阶段使用固定 digest 的 Node 26.11.1 Debian 镜像。SQLite 原生二进制随安装包提供；构建上下文排除宿主 node_modules 和参考仓库。

1. 将 `.env.example` 复制为 `.env`，将 `deploy/empty.example.json` 复制为 `deploy/relanox.json`。
2. 按 [配置](configuration.md) 填入所选账号、endpoint 和绑定，在 `.env` 设置凭据。空配置只检查安装，不能转发消息。
3. 运行 `docker compose build`，再运行 `docker compose run --rm relanox validate --config /config/relanox.json`。
4. 运行 `docker compose up -d`，通过 `docker compose ps` 和 `docker compose logs --tail 100` 检查。

Compose 将业务 HTTP 发布到宿主 `127.0.0.1:8787`。反向代理提供公开 HTTPS，只转发所选插件文档中的 `/channels/<account>/...` 和 `/agents/<kind>/...` 路由。长连接插件需要出站网络。代理日志不要记录正文、Authorization 或密钥查询参数。

管理 listener 保持容器 `127.0.0.1:8788`，不发布端口。镜像健康检查请求 `/health/ready`；修改端口时同步修改 healthcheck。`/health/live` 表达进程接收状态，`/health/ready` 还检查存储与工作循环新鲜度，渠道连接单独通过指标表达；启用 standard 观测时 `/metrics` 提供 Prometheus 指标。在同一网络命名空间抓取，例如共享服务网络的 sidecar，或通过显式鉴权的本地代理。管理端点不要公开。

启动自动创建缺失表和索引并保留工作。更新时停止网关、备份、重建、启动并检查就绪。Compose 允许 20 秒关闭，对应 CLI 默认 15 秒预算；需要更多时间时一起增大。`docker compose down` 保留命名 volume；`down --volumes` 会删除数据。

## 备份与恢复

SQLite 使用 WAL。离线备份先正常停止 Relanox，再复制整个数据目录，包括残留 WAL/SHM 文件。写入中不能只复制主文件。PostgreSQL 使用服务端一致性备份工具并保留配置 schema。先在独立测试实例验证恢复；评估恢复时不能让两个副本同时使用相同真实渠道凭据。

`status` 和 `doctor` 默认不展示正文。长期 claimed 请求在重启后保持 claimed，重启不授权第二次远端执行。已知临时发送失败沿持久计划退避；没有足够幂等能力的模糊发送保持 unknown。

恢复 unknown 前，检查平台会话，确认是否已经产生效果，再用当前版本与 `--acknowledge-unknown` 显式承认重复风险。delivery requeue 不重跑 Agent，并保留已经发送的分片和回执；request requeue 撤销旧 claimToken。版本冲突时重新读取状态，不使用陈旧版本重试。

保留清理只处理符合条件的终态数据。待处理请求和未送达结果保留。按保留策略调度 `cleanup`，妥善保护含文字和协议状态的备份。旧请求的快照保存环境引用名，恢复时仍需对应凭据。

endpoint 快照冻结 SecretRef 名称，不冻结解析后的值。Grok Routine URL 本身可能携带密钥，在 dispatch 时解析。仍有待处理请求时，不要将原环境变量改指另一 Routine；新目标使用新变量和新 endpoint。沿同一引用轮换凭据是有意操作，不通过持久化解析后的密钥实现冻结。

## 监控

[Prometheus 告警示例](https://github.com/relanox/relanox/blob/master/deploy/prometheus-alerts.yml) 需要按托管 Agent 预期耗时调整阈值，并由已有监控系统配置通知。连接状态按渠道插件聚合所有账号，独立于服务 readiness。额外监控抓取可用性 `up`，区分进程停止与指标陈旧/缺失。示例不安装监控服务。

指标与 trace 配置见 [可观测性](reference/observability.md)。每个部署仍需配置账号权限、DNS/TLS 和平台审核前提。

## 传输与冻结身份

凭据保持为 SecretRef，拒绝重定向。明文传输要求所选插件显式启用回环选项，并使用插件允许的回环地址（部分渠道也允许 localhost，dot/Grok 要求字面量回环地址），不能换成远端不安全 endpoint。

发送目标冻结渠道身份。当前 bot/app/service 身份改变时，先恢复原配置与凭据身份，再显式恢复保留的 delivery。旧目标缺少必需冻结身份时，不能补入当前身份代替；核查原目标，必要时人工投递，不为通过发送校验改写持久身份。unknown 没有声明安全幂等能力时绝不自动重放；恢复仍要求当前版本与风险确认。
