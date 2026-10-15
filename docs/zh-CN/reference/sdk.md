# 扩展接入

本指南面向新增原生聊天渠道或修改 Agent 接入的贡献者。如果只是连接已支持的账号，请使用[渠道指南](../channels/index.md)和[配置](../configuration.md)，无需使用 SDK。

## 从公开 SDK 开始

`@relanox/sdk` 提供渠道、Agent 和存储使用的类型，公开入口是 `packages/sdk/src/index.ts`。请使用导出的类型，并选择一个传输方式相似的已有接入作为起点。安装和检查步骤见[贡献指南](../development.md)。

渠道接入负责接收平台事件和发送回复；Agent 接入负责认证 Agent、通知输入以及接收回复。Relanox 会提供限定权限的 host，用于保存消息和检查访问权限。请通过 host 操作，不要直接打开数据库。

## 打包原生插件

插件包在 `package.json` 中声明原生身份和编译后的入口：

```json
{
  "name": "@relanox/channel-telegram",
  "type": "module",
  "files": ["dist"],
  "relanox": {
    "kind": "channel",
    "id": "telegram",
    "sdkMajor": 1,
    "entry": "./dist/plugin.js"
  }
}
```

SDK 导出 `PluginManifest`。`kind` 为 `channel`、`agent`、`storage`、`observability` 或 `middleware`；`id` 是原生渠道或 Agent 选择值、存储 ID（`sqlite` 或 `postgres`），标准可观测性使用 `standard`。腾讯语音包 `@relanox/speech-tencent` 声明类型 `middleware` 和清单 ID `speech-tencent`，插件实例 ID 仍为 `speech-tencent`。当前 SDK 主版本为 1。入口必须位于包内，解析符号链接后也不能越出包目录。

从入口导出名为 `createPlugin` 的同步工厂，返回身份对应的类型化 SDK `ChannelPlugin`、`AgentPlugin`、`StoragePlugin`、`ObservabilityPlugin` 或 `MiddlewarePlugin`。例如，Telegram 包的 `src/plugin.ts` 调用现有工厂：

```ts
import { createTelegramChannel } from './index.js'

export function createPlugin(): ReturnType<typeof createTelegramChannel> {
  return createTelegramChannel()
}
```

保留供直接调用者使用的现有命名导出。编译入口，并在打包文件中包含 `dist`；存储包还必须包含生成的 `migrations` 目录。工厂和模块导入不能建立连接，因为配置校验会在 setup 前导入包并调用工厂。通过插件的 setup 生命周期启动平台和存储连接。

本地开发先构建包，再将 `plugins.load.paths` 指向包目录；修改后重新构建并重启。测试安装时打包为 `.tgz`，再使用[配置参考](configuration.md#安装和加载原生插件)中的 CLI 安装命令。该接口用于 Relanox 原生接入。

## 添加渠道

1. 定义并验证账号配置。凭据字段使用环境变量引用；验证配置只检查值，不发起网络请求。
2. 认证传入的平台事件，提取稳定的事件标识，将文字、支持的附件和会话信息交给渠道 host。传输支持控制确认时，等待输入保存成功后再向平台确认接收。SDK 管理的接收游标可能提前推进，需要说明这一边界。
3. 声明平台的文字长度限制和支持的媒体类型。Relanox 在发送前拆分文字，接入代码处理平台原生上传和下载。
4. 实现 `resolveChannel(address, learned)`，把绑定的 `ChannelAddress` 解析为原生目标，或返回不可用原因。平台需要上下文时使用已认证的原生信息，不要伪造来信。可用性只是当前快照，实际发送时仍需检查会过期的窗口和凭据。
5. 实现单个消息部分的发送。重试时保留原发送标识，成功时返回平台回执，并区分明确的临时失败和不确定结果。
6. 通过 host 注册回调处理程序。应用负责监听地址，渠道路由会挂载在 `/channels/<accountId>` 下。

回复文字统一使用 Markdown。用 `capabilities.maxTextLength` 和 `lengthUnit` 声明平台长度限制，Core 会在保持格式和链接完整的前提下分段。如果转换后的消息大小不同，使用 `@relanox/markdown` 实现 `splitText(markdown, target)`，按实际发送格式计量长度。原生支持 Markdown 的渠道发送源文本，其余渠道转换为平台支持的格式，不提供单独的纯文本模式。

`capabilities.maxChunksPerMessage` 限制一条回复的文字与媒体总分块数，`maxAttachmentsPerMessage` 限制附件数量，`maxTextLengthPerMessage` 按 `lengthUnit` 限制整条 Markdown 源文本长度。Core 在保存回复前检查这些限制。平台需要合并回复时，可以通过 `SendInput.chunkCount` 判断最后一个部分。

回复已经准备好、等待平台取走时（例如企业微信回调刷新），返回 `pending` 与 `retryAfterMs`。Worker 延后同一部分，不消耗失败次数，也不记录为已送达。渠道观察到平台交接后再返回 `sent`。实际失败使用失败结果；等待外部回调不应耗尽发送重试次数。

每个配置的账号都有自己的渠道实例。不要把凭据放进消息上下文、回复位置或日志。适配层自行管理且需要持久化的协议状态使用 host 状态存储。QQ 的内存连接状态和原生回复序号交给官方 SDK，Core 的投递标识独立保留。

Core 从当前账号的绑定提供 `host.boundChatIds`。长连接渠道可用它订阅已配置的会话；IRC 用它加入频道，无需单独的频道列表。部署的公开地址通过 `host.publicUrl` 获取。

### 原生文字和图片布局

仅在原生协议接受有序文字和图片内容时声明 `capabilities.richText`。其中 `maxParts` 计算每个分块中的文字和图片部分数，`maxTextLength` 按 `lengthUnit` 限制这些部分的源文本总长度。可选的 `imageMimeTypes` 和 `maxImageBytes` 限制行内图片。`maxTotalImageBytes` 限制每个分块的图片总字节数，设置时应为平台请求的其他字段预留空间。Core 按这个总量拆分富文本分块；超出单图行内限制时，在原位置通过独立媒体发送图片，只发送一次。普通媒体限制和整条消息限制仍适用。

Core 解析[按 Markdown 顺序发送媒体](media.md#ordered-markdown-media)中的引用，检查渠道归属和图片类型，拆分闭合格式的文字，并在入队前固定投递计划。`DeliveryChunk.richText` 包含有序的 `RichTextPart` 文字和图片条目，与非空 `text` 和独立 `media` 互斥。`SendInput.richMedia` 按阅读顺序提供已验证的存储图片。将这些字节与分块引用对应，使用平台的原生上传或图片 URL 表达方式，不要下载内部 Markdown URI。需要跨重试复用的平台上传 ID 应保存在渠道状态中。

没有声明 `richText` 的渠道接收有序文字和独立媒体分块。企业微信 HTTP 合并为先文字后图片的一条最终回复，IRC 拒绝附件。`host.status()` 返回对应的 `richText` 模式，原生布局还提供 `richTextLimits`。本地协议测试应验证实际原生请求和行内图片降级行为，不代表真实账号兼容性已经验证。

## 扩展 Agent 接入

先认证请求，再取得仅允许访问指定端点的 Agent host。`host.status()` 从当前授权绑定列出 channel，包含原生发送可用性和限制。来信携带 `source.channel` 与 `source.senderId`，公开发送和媒体工具使用 channel ID。内部来信 request ID 仍用于事件去重和通知恢复。

发送调用为 `sendMessage({ channel, text, idempotencyKey?, attachments?, reply? })`，目标来自 `source.channel.id` 或 status 返回的 channel，无需先收到消息。不关联来信的发送或进度消息未提供键时，每次调用都会创建新发送；仅在重试同一次发送意图、文字和有序附件都相同时复用明确的键。返回 `queued` 表示消息已经保存，等待发送。`host.status({ deliveryId })` 仅在该投递所属 channel 仍获授权时返回投递信息。

附件可以引用所选 channel 中收到或已上传的媒体，也可以包含新生成的字节。签发上传凭证前，用 `host.media.authorize({ channelId })` 检查权限；`host.media.upload({ channelId, mediaId, upload })` 保存归属于该 channel、不可覆盖的媒体。`host.media.read({ channelId, mediaId })` 读取可用字节。存储会在写入事务中重新检查当前归属、封面和未发送上传额度。入队后，引用的上传文件释放暂存额度；每条消息独立检查媒体限制。上传不会创建待发送消息，之后再将返回的 ID 传给 `sendMessage`。附件形式见[媒体传输](../media.md)和 SDK 导出的类型。

通过 host 在 `/agents/<agentId>` 下注册 Agent HTTP 路由。不要把端点凭据混入通知或工具返回的字段。dot 和 Grok 已通过 `packages/agent-mcp` 共用 MCP 认证和消息工具；修改这些接入时可以复用现有辅助代码。

使用 `host.readMessages({ requestId?, limit?, pending?, cursor? })` 补取保留的来信内容。读取会检查当前端点和频道归属，排除已清理记录、端点配置和私有回复目标。未传入 ID 时，先查询各授权端点最近的记录，再过滤权限，最多返回 `limit` 条消息（默认 5，最大 20）。读取不会领取或确认任务。设置 `pending: true` 可从旧到新读取仍保留正文的未完成来信，将最后一条的 `{ acceptedAt, requestId }` 作为 `cursor` 继续读取。MCP 封装会将其作为 `nextCursor` 返回。未完成筛选在数据库限量前应用当前有效频道和端点权限。每条读取结果包含 `reply` 状态。发送时传入 `reply: { requestId, kind: "progress" | "final" }` 可关联来信，也可用 `host.status({ requestId })` 查询状态。每条来信只有一个最终投递，全部发送完成后才算完成。详见[消息状态与恢复](core.md)。

## 添加消息中间件

`MiddlewarePlugin` 提供 `kind: 'middleware'`、离线的 `validateConfig`，以及返回 `MessageMiddleware` 的 `setup`。嵌入时向 `createCore({ middleware: [first, second], ... })` 传入有序数组；省略时保持普通转发。中间件标识必须唯一，因为保存的结果和扩展元数据使用此标识。CLI 通过顶层可选 `middleware` 数组选择插件并确定执行顺序，没有固定的插件数量上限。

- `plan(message)` 同步筛选原始来信，不调用外部服务。返回不含凭据的 JSON 选项表示参与，返回 `undefined` 则跳过。核心将选中的标识、顺序和选项随原消息保存。筛选异常会跳过；凭据留在已配置的插件实例中。
- `process({ message, options, readMedia, signal, observe })` 接收前序成功步骤的输出、已保存选项、取消信号和受限媒体读取能力。消息只含公开内容，不含端点密钥或私有回复目标。`readMedia(id)` 只能读取这条原始消息的附件。
- 返回 `{ text, data? }`。核心验证、保存各步结果，将可选数据放在 `extensions[id]` 下。中间件不能改变路由或原始附件。某一步失败时保留此前内容，后续步骤仍可继续。整链合计限时十秒；必须响应取消，避免重试可能已计费的外部请求。
- 返回 `null` 过滤整条消息，停止后续中间件和 Agent 通知。`{ text: '' }` 仅清空正文，仍保留附件。过滤结果在重启、移除插件后继续生效；Agent 的消息读取不返回它，关联回复和重新通知均被拒绝，请求状态显示 `rejected`、原因 `middleware_filtered`，没有投递 ID。管理员仍可检查原始消息，直到保留期清理。异常、无效结果、插件缺失和超时仍沿用原有的继续转发策略，因此权限控制应使用渠道授权。

新增内置中间件时，将其包加入 CLI 依赖，并在 `apps/cli/src/middleware.ts` 中注册导出的 `MiddlewarePlugin`。注册表统一提供配置校验和实例创建，配置 schema 与启动流程无需增加插件专用分支。注册顺序不决定执行顺序；只有用户配置的条目会执行 setup。省略数组或设为空数组表示全部关闭。未知或重复的插件标识会在 setup 前被拒绝。目前随包提供的实现是 `speech-tencent`；注册机制不会自动安装或发现外部包。

原消息和执行计划入库后 Core 才确认接收，之后在通知或 Agent 读取前完成预处理。整链结果一起保存，通知重试复用这些结果。重启后，待处理任务仍使用接收时保存的顺序和选项；缺失的中间件以 `disabled` 跳过。预处理租约过期则记录 `interrupted`，转发原始内容，不重新执行整条链。删除插件不会删除已完成结果；保留期清理会同时清除所有派生文本和元数据。

`@relanox/speech-tencent` 通过此接口使用腾讯云官方 SDK，仅在 setup 时加载。插件负责音频筛选、模型选项、转写标记、逐段失败元数据及语音指标，在所有目标 Agent 之前生效，不导入 dot、Grok、渠道或数据库代码。Core 没有 ASR 专用的运行接口或任务类型。详见[配置与升级说明](configuration.md#speech-to-text)。

## 保存 channel 和投递

Core 在设置接入之前通过 `registerConversations` 登记配置中的会话。存储独立保存已认证的原生目标信息。`enqueueMessage` 检查 channel 授权，并一起保存端点、解析后的目标及渲染分块。发送顺序和显式幂等键以 channel 为边界。

`getMessageReceipt` 与不可变的 `media.getReference` 元数据使已授权的显式键重试能在媒体字节清理后返回原投递记录；它们不会恢复文件读取，也不允许用已清理文件发起新发送。清理时保留未完成投递及其引用的媒体。

## 嵌入 Core

直接调用 `createCore` 时，`worker` 仅接受 `maxMediaBytes`、`maxTotalMediaBytes` 和 `maxAttachments`。调度、重试、租约和请求预算采用内部默认值。CLI 通过顶层 `mediaLimits` 提供相同的附件限制。CLI 配置省略 `relay.observability` 会使用标准日志和指标，需要覆盖时再提供明确的可观测性配置。

## 检查接入是否正确

通过公开接口检查认证、发送者限制、重复事件、回复位置、媒体限制和失败恢复。平台响应可以使用本地 HTTP 或 socket 对端，恢复测试使用真实数据库。按[贡献指南](../development.md)补充测试理由。

渠道指南应帮助实际配置账号的人：说明平台凭据、所需权限、回调地址、支持的媒体和限制。引入协议行为时引用平台的一手文档。将真实账号验证与本地测试分别记录，让用户清楚哪些已经验证。
