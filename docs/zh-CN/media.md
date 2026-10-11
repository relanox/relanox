# 图片、音频、视频与文件

Relanox 将入站媒体与请求一起保存，并把生成的媒体发回原会话。支持范围取决于各渠道的原生协议与权限。文字和附件组成一个持久请求，纯媒体消息不需要补占位文字。回复使用最终结果，不做流式更新。

[渠道指南](configuration.md) 分别说明收发方向、格式及平台限制。IRC 没有标准化的原生附件传输；LINE Messaging API 不能发送任意文件；Google Chat 机器人身份使用图片卡片和下载按钮，下载按钮不等于原生上传的文件附件；Teams 文件发送依赖私聊中的用户同意。即使托管 Agent 能生成文件，这些目标渠道限制仍然适用。

## Agent 工作流程

`relanox_list_pending` 和 `relanox_claim` 返回的请求包含附件元数据：`id`、`kind`、`mimeType`、`fileName`、`size`、`sha256`，以及可选的 `durationMs` / `previewMediaId`。Routine 与通知 JSON 不内嵌二进制字节。

1. 先领取请求，再读取或生成附件。
2. 携带 `requestId`、`claimToken` 和 `mediaId` 调用 `relanox_read_media`。不超过 1 MiB 的图片和音频返回内联 MCP 内容，其余媒体返回二进制下载的资源链接。
3. 对生成的媒体，选定稳定 UUID，使用 `method: "PUT"`、该 `mediaId`、请求与领取信息及元数据调用 `relanox_media_transfer`。向返回 URL PUT 文件原始字节；成功响应包含已保存的 `media.id`。
4. 携带最终 `text` 和有序 `attachments: ["media-id", ...]` 完成请求。有附件时允许空文字，也可直接返回该请求已有的附件。重试须复用结果 ID、文字及附件顺序。

上传元数据包括 `kind`（`image`、`audio`、`video` 或 `file`）、`mimeType` 和不含路径的 `fileName`。目标平台要求音视频时长时，提供正整数 `durationMs`。需要原生视频或图片预览时，先上传图片，再以其 ID 填写 `previewMediaId`。预览图必须属于同一请求，不必作为单独的最终附件发送。

传输 URL 五分钟后过期，并绑定 endpoint、请求、claim、方法和元数据。URL 本身具有访问权限，不应写入渠道回复或日志。上传重试复用相同 UUID 和字节；相同 UUID 搭配不同字节或元数据会冲突。重新入队请求会撤销旧 claim。这类私有传输 URL 与下文的原生平台下载 URL 分开管理。

dot 和 Grok 都提供媒体工具。托管客户端需要支持相关流程用到的内联 MCP 媒体、资源下载及原始二进制 PUT。本地协议测试执行真实 MCP 请求、存储与字节传输，但不能证明某个托管账号会自动下载资源或上传生成文件。部署时应配置并验证客户端行为。

## 原生发送使用的公开 URL

部分平台通过 URL 拉取出站媒体，不直接接收上传。使用这类适配器时，在 CLI 配置顶层添加公开 HTTPS origin：

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

网关默认每个附件最多 25 MiB，每个入站请求或最终结果总计 50 MiB、十个附件。`mediaLimits` 可调整为每个附件最高 200 MiB、总计最高 200 MiB、最多十个附件。平台自身的格式与大小限制仍然适用，包括更小的图片和预览图限制。暂存附件共享原子的单请求预算，数量和总字节上限均为配置值的两倍，入站附件、预览图和生成结果一起计入。

下载按实际字节数和超时限制执行，拒绝重定向，只向受信平台 origin 转发凭据。不可信远程媒体 URL 不能访问私有网络地址。二进制存入 SQLite BLOB 或 PostgreSQL bytea，并保存请求归属元数据，因此数据库备份也包含附件；应考虑其容量与敏感性。

完成请求时，先提交文字分片，再按指定顺序提交附件分片。每片独立保存发送进度和回执；后续附件失败不会重发已成功的前序分片。模糊外部发送仍保留 `unknown`，需要显式恢复；进程重启不代表平台发送可以安全重复。

只有请求满足清理条件时，保留策略才移除媒体字节和识别元数据，未完成请求与未送达结果仍被保留。清理会使尚未到期的公开 URL 失效。保留时间应为平台拉取及用户使用下载按钮留出余量。备份与恢复命令见[部署与运维](operations.md)。
