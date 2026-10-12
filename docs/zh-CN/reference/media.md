# 媒体配置与协议

连接好渠道和 Agent 后，就可以在聊天里发送图片、音频、视频或文件。比如发一张截图请 Agent 解释，上传文档请它整理要点，或让它把生成的图片发回当前聊天。

先用一张小图片试一遍：发送图片并写上“请描述这张图片”。Agent 能读取附件并回复后，再尝试你需要的文件类型。

## 让 Agent 读取附件

MCP 连接自带附件说明，并提供 `relanox_read_media`、`relanox_send_message` 和 `relanox_create_upload` 工具。Agent 将 `source.channel.id` 用作 `channel`，将来信附件的 `id` 用作 `mediaId`。这些 ID 随消息提供，无需另配附件 prompt。接入步骤见[连接 Agent](../agents.md)，消息格式见 [Agent 协议](agents.md#incoming-messages)。

媒体归属于已授权渠道。读取、上传和发送时必须选择该渠道，其他渠道的 `mediaId` 不能用于附件或封面。上传或发送前，可通过 `relanox_status` 查询已授权渠道及支持的媒体。

`relanox_read_media` 将不超过 1 MiB 的图片和音频作为 MCP 内容返回。不超过 64 KiB 的 UTF-8 纯文本、Markdown、CSV、TSV 和 JSON 文件以嵌入文本资源返回。其他文件返回有效期五分钟的下载资源链接。链接期限控制访问，不决定文件保留时间。如果 Agent 无法读取返回的内容或下载文件，应说明这一限制。

## 让 Agent 发回生成的文件

dot 可以在 `relanox_send_message.files` 中传入宿主提供的 `openai/fileParams` 文件对象。Relanox 从其中的临时下载地址取得字节，保存后发送。OpenAI 的 `file_id` 不是 Relanox 媒体 ID。

Grok Bot 可以调用 `relanox_create_upload`，把云电脑中的文件通过 PUT 上传到返回的签名地址，再将成功响应中的 `fileId` 用作 `attachments[].mediaId`。能使用终端或 HTTP 工具的 dot 也可以走这条路径。上传沿用现有公网地址和数据库，无需另开对象存储账号。协议和示例见 [Agent 文件工具](agents.md#上传本地文件)。

`attachments` 仍然接受直接返回文件内容的公网 HTTPS 链接。音视频目标渠道可能需要 `durationMs` 和封面，可通过上传工具或 URL 附件参数提供这些信息。发送前查看[对应渠道指南](../channels/index.md)。

签名上传地址有效期为五分钟，只授权所选 `channel` 下的一个不可覆盖文件。在有效期内使用相同地址重试相同字节会成功，不同字节不能覆盖已有文件。上传只会保存文件，不会发送；保留返回的文件 ID，用于发送调用。请把上传地址当作临时凭据保管。五分钟限制的是通过该地址访问的期限，不会自动删除上传的文件。

每次新发送使用新的 `idempotencyKey`，例如新生成的 UUID。重试同一次发送时，复用该键、相同文字以及内容和顺序均相同的附件。不提供键时，每次调用都会创建新消息，即使内容完全相同。`queued` 表示已保存等待投递；使用返回的 `deliveryId` 调用 `relanox_status` 查看进度，不要用新键再次发送。

## 为部分渠道设置文件下载地址

以下发送方式需要 Relanox 提供一个可从公网访问的 HTTPS 地址：

| 渠道            | 使用下载地址的内容                 |
| --------------- | ---------------------------------- |
| LINE            | 图片、音频和视频                   |
| Google Chat     | 图片卡片和文件下载按钮             |
| Microsoft Teams | 群聊或频道中大于 15,000 字节的图片 |

在 `relanox.json` 顶层设置 `publicUrl`。如果已经为 Agent 连接配置过，媒体会自动使用同一个地址：

```json
{
  "publicUrl": "https://relay.example.com"
}
```

把 `relay.example.com` 换成你的域名，并让反向代理将 `/media/` 下的请求转发到 Relanox 的业务端口，默认是 `8787`。域名配置方法见[部署与日常管理](../operations.md)。

下载链接默认有效期为 24 小时。持有链接的人可以在有效期内访问文件，因此请把它当作临时文件分享链接管理。需要调整时再添加可选的 `media` 对象，例如 `"media": { "urlLifetimeMs": 3600000 }` 表示一小时。该值以毫秒计，最多可设为七天。

Teams 私聊中的大图片和文件使用平台的文件接收确认流程。IRC 用于文字聊天；LINE 可以接收文件，并发送图片、音频和视频。每个平台的具体呈现方式见其[渠道指南](../channels/index.md)。

## 调整附件大小

默认每个附件最多 25 MiB，一条消息合计 50 MiB，最多 10 个附件。可以在配置顶层添加 `mediaLimits` 调整：

```json
{
  "mediaLimits": {
    "maxMediaBytes": 26214400,
    "maxTotalMediaBytes": 52428800,
    "maxAttachments": 10
  }
}
```

前两项以字节计，分别表示单个附件大小和一条消息的附件总大小，上限均为 200 MiB。`maxAttachments` 最高为 10。修改后重启 Relanox。

聊天平台也有自己的文件要求。发送前同时检查文件类型和大小。`relanox_status.mediaLimits` 将配置的单条消息限制显示为 `maxBytes`、`maxTotalBytes` 和 `maxAttachments`，各渠道还会报告支持的媒体及附件数量限制。封面字节计入单条消息总大小。遇到超限提示时，可以压缩文件、拆成几次发送，或调整 Relanox 的大小设置。

尚未用于发送的暂存上传文件另有每渠道额度，数量为 `maxAttachments` 的两倍，总大小为 `maxTotalMediaBytes` 的两倍。这限制的是等待使用的文件，不是聊天整个生命周期的累计额度。消息入队后释放其中所用文件的暂存额度，清理也会释放被删除上传文件的额度。每次发送仍须符合单条消息限制；封面必须是同一渠道拥有的图片。

## 文件保存在什么地方

Relanox 把已接收的附件和 Agent 上传的文件保存在配置的数据库中。暂存上传占用每渠道额度，直到用于已入队消息或被清理。备份数据库会同时备份这些文件，因此请为图片和视频留出存储空间。

日常清理会删除符合条件的旧附件，相关下载链接也会随之失效。选择清理时间时，为收件人下载文件留出时间。具体命令见[备份与清理](../operations.md)。

保留的媒体元数据和发送回执，使清理后内容相同的带键重试仍能返回原投递记录。这不会恢复已删除的文件字节，也不会让清理过的附件重新可读。新的发送需要可用的文件字节。

## 附件没有发出来时

1. 先发一条文字，确认账号和 Agent 已接通。
2. 使用小图片重试，检查是否与文件大小或格式有关。
3. 如果由 Agent 生成文件，检查上传是否返回文件 ID，以及 Agent 是否用它调用发送工具；使用 URL 附件时，确认地址能直接下载文件。
4. 使用 LINE、Google Chat 或 Teams 群聊图片时，检查上面的下载地址设置。
5. 查看[消息状态与恢复](core.md)，按提示处理待发送的消息。
