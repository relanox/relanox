# 托管 Agent

`@relanox/agent-dot` 和 `@relanox/agent-grok` 导出 `createDotAgentPlugin()` 与 `createGrokAgentPlugin()`。Core 每种 Agent 装配一个实例，setup 前校验全部 endpoint 配置，向 setup 提供原始 endpoint 与 `{}`。接纳消息时冻结 endpoint JSON/SecretRef；插件 setup 与 dispatch 分别解析配置，凭据在使用时解析环境值。

账号安装与远端 Agent 固定指令属于部署前提；传输回执不代表远端执行成功。

## 两种接入方案

两种方案都将已有的托管 Agent 连接到 Relanox 提供的 HTTPS MCP 地址，不调用模型推理 API，也不在本地启动 Agent。远端配置对应 endpoint 的 Bearer 凭据，并遵守“先领取，再执行，最后完成或报告失败”的指令。渠道绑定决定会话交给哪个 endpoint。

|          | Grok                                                                  | dot                                                                 |
| -------- | --------------------------------------------------------------------- | ------------------------------------------------------------------- |
| 触发方式 | Relanox POST 到指定 Routine webhook                                   | dot 订阅 `relanox.message_available`，Relanox 发送签名 webhook 事件 |
| 初始内容 | Routine 的 `content` 包含安全请求投影                                 | 事件只携带 `requestId`，Agent 再通过 MCP 读取和领取                 |
| 远端配置 | 创建 Routine，复制 webhook URL 与完整 Authorization 值，接入 MCP 工具 | 连接 MCP endpoint，建立 Events 订阅，并授权准确的 callback origin   |
| 回传结果 | `relanox_complete` 或 `relanox_fail`                                  | `relanox_complete` 或 `relanox_fail`                                |

Grok 需要设置 `GROK_ROUTINE_URL`、`GROK_ROUTINE_AUTHORIZATION` 和 `GROK_MCP_TOKEN`，让托管 Agent 连接 `/agents/grok/mcp/<endpointId>`，并在 Routine 中配置下文的领取/完成指令。webhook 返回 2xx 只代表接收，不代表最终回答。

dot 需要配置 `/agents/dot/mcp/<endpointId>` 及 token，授权订阅提供的 callback origin，并建立 Events 订阅。Relanox 完成 callback challenge 验证后才激活订阅；订阅方必须在 `refreshBefore` 前续订，没有有效订阅就无法收到推送通知。

如果远端客户端自己发起 MCP 轮询，两者都可以使用 `dispatchMode: "pull"`；Relanox 不会替远端启动轮询。媒体处理还要求客户端能下载二进制 URL，并通过 PUT 上传生成文件，再携带媒体 ID 完成任务。本地测试验证协议和持久化行为，真实托管账号仍需具备这些工具能力并遵守执行指令。

## 配置与 HTTP 路由

每个 endpoint 有独立 MCP 路由 `/agents/dot/mcp/<endpointId>` 或 `/agents/grok/mcp/<endpointId>` 和 Bearer 凭据。为不同授权范围使用独立随机凭据。在调用 MCP 或获取限定 Host 前进行常量时间摘要比较。工具参数不能选择 endpoint。

URL host 必须与 Host 头一致，并命中 `allowedHosts`。存在 Origin 时必须精确命中 `allowedOrigins`；默认空列表允许没有 Origin 的服务端请求。转发 host/origin 头不受信任。配置真实公开 authority，包括非默认端口，或让可信代理保留它。

dot endpoint 示例：

```json
{
  "id": "my-dot",
  "agent": "dot",
  "dispatchMode": "push",
  "config": {
    "mcp": {
      "token": { "env": "DOT_MCP_TOKEN" },
      "allowedHosts": ["relay.example.com"],
      "allowedOrigins": [],
      "maxBodyBytes": 1048576,
      "timeoutMs": 10000
    },
    "callback": {
      "allowedOrigins": ["https://connectors.api.openai.com"],
      "transport": "public-https",
      "timeoutMs": 10000
    },
    "subscriptionTtlMs": 86400000,
    "rotationWindowMs": 60000
  }
}
```

callback origin 是操作者的授权选择，应核实账号订阅实际提供的精确 origin；示例不代表所有账号都使用该地址。缺失或伪造 Content-Length 仍受字节上限约束；MCP 正文和 callback/trigger 调用都有期限，Core 也有自身限额。

Grok endpoint 示例：

```json
{
  "id": "my-grok",
  "agent": "grok",
  "dispatchMode": "push",
  "config": {
    "mcp": {
      "token": { "env": "GROK_MCP_TOKEN" },
      "allowedHosts": ["relay.example.com"],
      "allowedOrigins": [],
      "maxBodyBytes": 1048576,
      "timeoutMs": 10000
    },
    "routineUrl": { "env": "GROK_ROUTINE_URL" },
    "routineAuthorization": { "env": "GROK_ROUTINE_AUTHORIZATION" },
    "routineTransport": "https",
    "timeoutMs": 10000,
    "maxBodyBytes": 1048576
  }
}
```

Routine URL 和完整 Authorization 从所选 Routine 界面复制，插件不构造内部 URL，也不添加 Bearer 前缀。MCP 变量则只保存原始 token，不包含 `Bearer `。凭据不能进入渠道 context 或消息文字。

同机受控接收器可显式使用 dot `callback.transport: "loopback-http"` 或 Grok `routineTransport: "loopback-http"`，只允许字面量 `127.0.0.1` 或 `[::1]`。dot 仍要求包含端口的精确 origin 白名单。这是显式部署选择，不自动检测开发环境。公开 callback 使用 HTTPS。

dot 每次连接前解析全部目标地址，拒绝非公开/特殊地址，并通过 Node connection lookup 固定地址、保留 TLS 主机名、禁用池化和重定向。IPv6 策略保守排除特殊/过渡地址。Grok URL 是管理员 SecretRef，不是工具调用者输入，也拒绝重定向。

## MCP 工具

MCP 使用服务端 SDK 的 `createMcpHandler(factory)`，每次 HTTP 请求建立新 server，持久状态在 Storage。dot 要求 `2026-07-28`，拒绝旧版；Grok 使用 SDK 默认无状态旧客户端兼容及现代协商。输入输出均为严格 schema。JSON/工具校验失败使用 SDK 协议错误；业务失败设置 `isError: true`，包含 `structuredContent.status` 与文字 JSON 镜像。

| 工具                     | 输入                                                                  | 成功结果                                       |
| ------------------------ | --------------------------------------------------------------------- | ---------------------------------------------- |
| `relanox_list_pending`   | 可选 `limit`，1–100，默认 20                                          | `{requests:[...]}`                             |
| `relanox_claim`          | `requestId`、`claimKey`                                               | `{status:"claimed",request,claimToken,replay}` |
| `relanox_complete`       | `requestId`、`claimToken`、`resultId`、`text`、可选有序 `attachments` | `{status:"completed",deliveryId,replay}`       |
| `relanox_fail`           | `requestId`、`claimToken`、`errorCode`                                | `{status:"updated",version}`                   |
| `relanox_read_media`     | `requestId`、`claimToken`、`mediaId`                                  | 内联图片/音频或二进制资源链接                  |
| `relanox_media_transfer` | 请求/claim、`mediaId`、`method`、上传 `metadata`                      | 五分钟二进制 URL 与字节限额                    |

列表、媒体读取和传输 URL 签发工具为只读，二进制 PUT 和 complete 执行写入。ID/key/token 为非空有界字符串，errorCode 为有界小写标识符，最终文字有大小限制。安全请求投影为 `{requestId,text,context,source:{channel,eventId},attachments?}`，附件只含持久元数据，不含二进制字节。不包含 endpoint 配置、SecretRef、发送者标识、私有 Routine URL、账号凭据或回复目标。context 是渠道协议上下文，正文不提供权限。二进制上传下载、时长与预览元数据、限额及托管客户端前提见[媒体传输](media.md)。

远端固定指令：产生工作或副作用前 claim；每个远端运行使用独立 claimKey，同一运行重试复用；只有 `status: claimed` 才继续；通过返回 token、稳定 resultId 和最终文字 complete；终态失败使用安全 errorCode fail。重复通知可能重叠，但持久 claim/token/final 规则串行化 endpoint。HTTP 回执不领取也不完成任务。claim 不自动超时释放；模型遵守指令和外部效果恰好一次没有保证。

## dot Events

事件为 `relanox.message_available`。鉴权路由已经固定 endpoint，订阅 arguments 是严格空对象。方法接受 MCP `_meta`，但不用于授权或身份。`events/list` 返回描述、`delivery:["webhook"]`、空输入 schema 和 `{requestId:string}` payload schema。发现响应在顶层 `capabilities.events` 声明事件能力，并保留 SDK 协商、头与版本校验。

`events/subscribe` 输入 `{name,arguments:{},delivery:{mode:"webhook",url,secret},cursor?,ttlMs?}`，cursor 只能为 null/缺失，不提供重放。返回 `{id,refreshBefore,cursor:null,truncated:false}`。鉴权 owner、规范 URL、事件名和 arguments 的规范 JSON 决定身份。StateStore 持久保存 owner/endpoint、callback、签名 key、有效期和有界验证/轮换状态。

默认期限一天，配置最多七天，请求时长不超过配置上限，最少 1000 ms。`ttlMs:null` 也只获得有限配置期限，refreshBefore 始终为实际过期时间。激活前，签名 POST 发送 `{type:"verification",challenge:<新随机值>}` 和独立 verification webhook-id，要求 2xx 且 JSON challenge 常量时间相等。失败返回 `-32015` CallbackEndpointError，不写入活跃订阅。

owner/URL/key 验证缓存最多 60 秒；新建、过期和 key 变化始终验证。匹配订阅经精确版本 CAS 续期，竞争返回 subscription_conflict，可重试。新身份创建时清理过期项；已有 100 个活跃订阅时拒绝新身份。这不是跨并发新身份的事务配额，应限制 callback 授权与订阅并发。

轮换时旧 key 默认重叠 60 秒，最多五分钟，窗口内用空格分隔的 `v1,...` Standard Webhooks 双签名。key 是规范 `whsec_` base64，解码 24–64 字节。callback 签名密钥必须持久保存以支持重启，需保护数据库；工具和日志不输出它。

每个适用活跃订阅发送一个事件：

```json
{
  "eventId": "evt_<requestId>",
  "name": "relanox.message_available",
  "timestamp": "<持久接纳时间 ISO 字符串>",
  "data": { "requestId": "<requestId>" },
  "cursor": null
}
```

ID 和序列化正文跨重试稳定，不携带正文/执行指令；通过读取/领取工具获取权威工作。正文最多 256 KiB。头包括 Content-Type、等于 eventId 的 webhook-id、当前 webhook-timestamp、webhook-signature、X-MCP-Subscription-Id。dispatch 重新检查过期与当前授权。没有活跃订阅时返回 retryable `dot_no_active_subscription`，保留任务；预算内续订可恢复通知，预算耗尽后显式 requeue。

2xx 表示接收；429/5xx 可重试；重定向和永久 4xx（含 410/413）拒绝。410 只退休实际发送的订阅版本，保留并发续订/重建。发送按 HTTP 状态丢弃响应正文，只有验证要求有界 JSON。408、网络/超时丢失状态响应为 unknown。多目标在有界 signal 下顺序发送，unknown 优先于 retryable，retryable 优先于 rejected。接收端去重仍是外部能力。

`events/unsubscribe` 按鉴权 endpoint 匹配 `{name,arguments,delivery:{mode,url}}`，不需要 secret。精确版本删除，缺失时幂等，不可触达其他 owner。丢失通知不能通过游标重放，但待处理业务请求仍可通过工具读取。

## Grok Routine 正文

提交 JSON 为 `{content,source:"relanox",sentAt}`。content 是 MCP 安全请求投影的 JSON 字符串，包含 requestId、原文字和最小协议 context。sentAt 为原始持久接纳时间，重试字节稳定。执行前 claim 的固定指令放在 Routine 配置和 MCP server instructions，独立于用户文字。总正文超限在传输前拒绝；不使用猜测的运行查询或结果 callback API。

| HTTP 结果                 | dispatch 分类                             |
| ------------------------- | ----------------------------------------- |
| 2xx                       | accepted，请求仍 pending                  |
| 429、5xx                  | retryable，采用有界 Retry-After 秒数/日期 |
| 408、网络错误、中止、超时 | unknown，显式运维恢复                     |
| 重定向与其余非 2xx        | rejected                                  |

这些是 Relanox 传输策略，不证明 Grok 内部副作用。MCP completion 是唯一持久最终结果入口。公开 Coda/Linq 示例展示 JSON/content 传输，不是完整官方 Webhook schema 或真实账号验证。

## 协议来源

- [OpenAI MCP Events](https://developers.openai.com/plugins/build/mcp-events)：发现、订阅、callback 验证、签名、轮换和发送限制。
- MCP SDK 的 [HTTP 服务](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/docs/serving/http.md)、[自定义方法](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/docs/advanced/custom-methods.md)、[版本](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/docs/protocol-versions.md)、[旧客户端](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/docs/serving/legacy-clients.md)。
- [Coda Pack 作者实现](https://connect.superhuman.com/t/how-a-coda-pack-calls-grok-bot/61506) 与 [固定 Linq 源码](https://github.com/jeffhuber/linq-grokbot-text-channel/blob/91eddc9203c28b747c81678f5012dd7e150b6c30/forwarder/api/index.js)：content/JSON 转发格式示例。
