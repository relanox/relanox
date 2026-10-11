# 第二轮源码职责审查

基线：`f67671d`。范围为 23 个工作区包的全部 174 个生产 TypeScript 文件；由三个 GPT-6.1 Sol 子代理分组审查，根代理复核并集成。计数属于基线，不以新增文件数衡量改善。唯一架构维护文档仍为 [ARCHITECTURE.md](../ARCHITECTURE.md#source-organization)，本文只记录本轮发现与验证。

## 覆盖与处理

| 包                     | 基线文件数 | 发现与处理                                                                                                                                                                  |
| ---------------------- | ---------: | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| sdk                    |          8 | 值、配置、消息、持久状态和插件契约职责清晰；保留既有结构。                                                                                                                  |
| core                   |         24 | 配置验证不再初始化连接状态；setup 在所有回调之前建立完整连接清单。worker 保持 dispatch/send 的判别联合关联，直接构造对应 Settlement，删除恢复类型关联的断言；输入依赖收窄。 |
| cli                    |         14 | 管理命令所需健康检查归入 storage；将仅搬移工厂名单的两个文件合回 plugins，静态装配入口有明确的窄依赖数量例外。                                                              |
| agent-dot              |          8 | 配置不再反向依赖 MCP/callback 实现；凭据操作独立，订阅和 dispatch 只接收 state，订阅有显式契约；投影留在现有 protocol。                                                     |
| agent-grok             |          4 | 配置与 MCP 解耦；Routine 不再为凭据和消息投影导入 MCP；两个消费者共享明确字段投影。                                                                                         |
| storage-sqlite         |         10 | 操作模块依赖收窄到实际使用的数据库能力；持久编码和记录比较命名明确；保留完整原子事务。                                                                                      |
| storage-postgres       |         10 | 显式数据库上下文与各操作能力范围；持久编码命名明确；保留 SQL、事务和版本围栏。                                                                                              |
| observability-standard |          8 | 指标先构造，入口统一拥有关闭与异常隔离；日志、指标和 tracing 返回契约明确；配置和期限函数按职责命名。                                                                       |
| channel-dingtalk       |          6 | 纯配置字段和 URL 策略归 config；token 回执 schema 归 schemas。                                                                                                              |
| channel-discord        |          7 | 配置不再依赖 transport；Gateway 有显式契约，握手和频道查询 schema 归 schemas。                                                                                              |
| channel-feishu         |          5 | 配置和 ID schema 依赖方向修正；消息解析命名清晰。                                                                                                                           |
| channel-googlechat     |          7 | 配置与 I/O 解耦，OAuth schema 归 schemas；删除未调用的复制 helper。                                                                                                         |
| channel-irc            |          6 | 配置基础 schema 不再来自协议运行模块；保留连接状态机。                                                                                                                      |
| channel-line           |          6 | 配置与 I/O 解耦，发送回执 schema 归 schemas。                                                                                                                               |
| channel-matrix         |          5 | 配置与 protocol 解耦，创建事件回执 schema 归 schemas。                                                                                                                      |
| channel-mattermost     |          5 | 配置与 protocol 解耦，创建帖子回执 schema 归 schemas。                                                                                                                      |
| channel-msteams        |          7 | 配置与 I/O 解耦，OAuth schema 归 schemas；删除未调用的复制 helper。                                                                                                         |
| channel-qq             |          6 | URL 和 SecretRef 归 config；token schema 归 schemas；回复分配有显式类型。                                                                                                   |
| channel-signal         |          6 | 配置与 protocol 解耦，发送回执 schema 归 schemas。                                                                                                                          |
| channel-slack          |          6 | 配置与 transport 解耦，Socket 握手和发送回执 schema 归 schemas。                                                                                                            |
| channel-telegram       |          6 | 配置独立拥有字段及 URL 策略，运行时依赖配置。                                                                                                                               |
| channel-wecom          |          5 | 配置与 transport 解耦，WS 回执 schema 归 schemas。                                                                                                                          |
| channel-whatsapp       |          5 | 配置与 I/O 解耦，发送回执 schema 归 schemas。                                                                                                                               |

## 保留的边界

连接恢复、游标和会话状态继续由单一运行对象拥有，不为缩短文件拆开状态机。Storage 的完成与出站创建、领取与版本校验仍在同一事务内。SDK 和包级导出不扩展；没有增加通用框架、运行依赖或持久格式。CLI 仍静态装配全部插件，本轮不声称改善启动加载范围。

全部十五个渠道的 config 只导入 Zod；协议 schema 不依赖网络 I/O。Agent 的配置 schema 同样不导入 MCP、HTTP 或凭据解析实现。相同形状的跨平台字段保持包内所有权，没有为去重建立泛化工具包。

## 验证

沿用既有公共 API、配置拒绝规则、协议与真实数据库测试，未新增或改写测试。分组验证：core/CLI 27 项，Agent/Storage/Observability 122 项（真实 PostgreSQL 与 SQLite），渠道及共享 URL/生产转发测试 258 项；分组有交叉，不能相加当作总数。

合并后的全工作区 build、format、严格 type-aware lint、typecheck 均通过；完整 Vitest 为 29 个文件、405 项通过，容器专用的 1 项本地跳过，交给 Linux CI 实际运行。此次本地测试使用 Node 26.11.1、pnpm 12.11.2、真实 SQLite 和 PostgreSQL 16；CI 的数据库版本为 PostgreSQL 18.6。

集成复核确认：175 个最终生产源码文件的相对导入图未发现环；全部渠道配置满足仅导入 Zod；构建后的包入口运行时导出名称与基线一致；SDK、package manifests 和锁文件没有变化。另一个子代理只读交叉审查了渠道的 60 个变更文件和服务侧的 38 个变更文件，没有留下阻止集成的发现。新提取的 22 个渠道协议 schema 逐一对照基线，校验表达式保持一致。

发布结果以对应 master 提交的 CI 四个任务为准。真实平台账户验证不在本轮范围。
