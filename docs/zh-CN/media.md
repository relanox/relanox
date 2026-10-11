# 图片、音频、视频与文件

Relanox 将入站媒体与请求一起保存，并把生成的媒体发回原会话。支持范围取决于各渠道的原生协议与权限。文字和附件组成一个持久请求，纯媒体消息不需要补占位文字。回复使用出站消息，不做流式更新。

[渠道指南](configuration.md) 分别说明收发方向、格式及平台限制。IRC 没有标准化的原生附件传输；LINE Messaging API 不能发送任意文件；Google Chat 机器人身份使用图片卡片和下载按钮，下载按钮不等于原生上传的文件附件；Teams 文件发送依赖私聊中的用户同意。即使托管 Agent 能生成文件，这些目标渠道限制仍然适用。

## Agent 工作流

dot 事件与 Grok Routine content 直接包含 replyTo 和附件元数据：id、kind、mimeType、fileName、size、sha256，以及可选 durationMs/previewMediaId，不含二进制字节。

1. 调用 `relanox_read_media({replyTo,mediaId})` 读取已有媒体。不超过 1 MiB 的图片/音频返回内联 MCP 内容，其他文件返回绑定 endpoint 与输入的五分钟签名 GET 资源链接。链接具有临时访问权限，不要写入回复或日志。
2. 用 `relanox_send_message` 发送文字/附件。返回已有媒体使用 `attachments:[{mediaId:"received-id"}]`；生成文件使用 `{url:"https://public.example/file",kind:"image",mimeType:"image/png",fileName:"picture.png"}`。网关限定大小/时间、校验 DNS/公网地址、拒绝重定向，下载后原子入队字节与消息。
3. 原生平台要求音视频时长时提供正整数 durationMs。图片 previewUrl 与主体原子下载/保存，previewMediaId 可引用同一输入已有的预览图。预览不需要作为单独回复附件。
4. 同一 replyTo 可以多次发送。有附件时允许空文字。重试复用显式 idempotencyKey 和相同内容/附件顺序；无 key 时相同内容去重，有意重复发送可使用不同 key。`queued` 不表示已送达。

没有独立上传或任务结算操作。SDK Host 可以将内存 MediaUpload 或 `{media,preview}` 对传给 sendMessage，MCP 客户端提供公网 HTTPS URL。dot 和 Grok 都暴露这两个工具。托管客户端需支持相应内联内容或资源下载，生成文件需可通过公网 URL 获取。本地协议测试不证明某个托管账号的行为。

## 原生发送使用的公开 URL

当前仍需公开 URL 的路径是 LINE 图片/音频/视频输出、Google Chat 图片卡片与下载按钮，以及 Teams 群聊/频道中大于 15,000 字节的图片。LINE 要求 HTTPS 媒体 URL；Google Chat 原生附件上传需要单独授权的用户身份，不能使用当前机器人凭据。QQ 使用原生签名分片直传，无需发布 URL。Teams 私聊中大于 15,000 字节的图片改用原生文件同意上传，以文件卡交付；小图仍内联。使用剩余的 URL 路径时，在 CLI 配置顶层添加公开 HTTPS origin：

```json
{
  "media": {
    "publicBaseUrl": "https://relay.example.com",
    "urlLifetimeMs": 86400000
  },
  "mediaLimits": {
    "maxMediaBytes": 26214400,
    "maxTotalMediaBytes": 52428800,
    "maxAttachments": 10
  }
}
```

将这些字段合并到包含 `relay` 的配置中；上述片段不是完整配置。在该 origin 下把 `/media/*` 转发至业务监听端口。origin 不能包含路径、query、fragment 或内嵌凭据。`allowInsecureLocalhost: true` 可显式允许本地协议测试使用回环 HTTP，公开平台拉取仍需可达的 HTTPS。

发布操作为一个账号、请求和附件生成不可猜测的 URL，在过期前保持重试与进程重启后的稳定性。默认有效期 24 小时，最长七天。持有链接即可访问，直到过期或附件清理。响应包含 `no-store` 和 `nosniff`，保留文件名与实际内容类型。网关不会从入站 Host 或转发头推断公开 origin。

直接上传媒体的渠道无需此配置。需要发布 URL 的适配器在没有 publisher 时会明确报告配置错误。Agent 私有下载 URL 不依赖 `media.publicBaseUrl`，它使用经过 MCP 鉴权校验的请求 authority。

## 限制、持久化与恢复

网关默认每个附件最多 25 MiB，每个入站请求或出站消息总计 50 MiB、十个附件。`mediaLimits` 可调整为每个附件最高 200 MiB、总计最高 200 MiB、最多十个附件。平台自身的格式与大小限制仍然适用，包括更小的图片和预览图限制。生成附件共享原子的单请求预算，数量和总字节上限均为配置值的两倍，入站附件、预览图和生成结果一起计入。

下载按实际字节数和超时限制执行，拒绝重定向，只向受信平台 origin 转发凭据。不可信远程媒体 URL 不能访问私有网络地址。二进制存入 SQLite BLOB 或 PostgreSQL bytea，并保存请求归属元数据，因此数据库备份也包含附件；应考虑其容量与敏感性。

消息入队时，先提交文字分片，再按指定顺序提交附件分片。每片独立保存发送进度和回执；后续附件失败不会重发已成功的前序分片。模糊外部发送仍保留 `unknown`，需要显式恢复；进程重启不代表平台发送可以安全重复。

保留策略对符合条件的入站文字/context/附件列表、出站内容/回执和二进制字节脱敏。持久去重和路由元数据仍保留，包括已保存媒体的文件名/摘要；到期/unknown 通知与未送达消息继续保留。清理会使尚未到期的公开 URL 失效。保留时间应为平台拉取及用户使用下载按钮留出余量。备份与恢复命令见[部署与运维](operations.md)。
