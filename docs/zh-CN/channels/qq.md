# QQ 私聊与群消息

## 媒体

私聊/群附件持久保存为字节后才推进 gateway 游标，支持纯媒体。下载限制 DNS 地址与字节、禁止跳转；`mediaOrigins` 可配置准确私有服务 origin，回环 HTTP 还需开启 `allowInsecureLoopback:true`。

中继顶层配置 `media.publicBaseUrl`，允许 QQ 获取输出字节。调用对应 `/v2/users/<id>/files` 或 `/v2/groups/<id>/files`，固定 `srv_send_msg:false`，再以 `msg_type:7` 和 `media.file_info` 输出，沿用持久被动回复序号。每次尝试获取新的 file_info 避免 TTL 过期，不混用私聊/群上传令牌。说明文字先独立发送，公开下载 URL 有期限并限定账号/请求。

当前原生协议支持 PNG/JPEG 图片、MP4 视频、SILK 音频与普通文件（`file_type:4`），不自动转码。平台软上限：图片/音频 20 MiB、视频 30 MiB、文件 200 MiB，仍受中继默认 25 MiB 上限限制。上传不会隐式产生主动消息。

协议依据：[富媒体](https://bot.q.qq.com/wiki/develop/api-v2/server-inter/message/rich-media.html)、[群上传](https://bot.q.qq.com/wiki/develop/api-v2/autogen/api/v2_groups_group_openid_files.post.html)。本地 HTTP、socket、SQLite 测试不代表实账号兼容性已验证。

账号 `config`（[配置说明](../configuration.md)）：

```json
{
  "appId": "robot-app-id",
  "clientSecret": {
    "env": "QQ_CLIENT_SECRET"
  },
  "transport": "websocket",
  "apiBase": "https://api.bot.qq.com",
  "allowProactive": false,
  "maxReconnectAttempts": 20
}
```

## 接入与身份

启用官方 QQ 机器人并授予 GROUP_AND_C2C_EVENT 权限，仅支持 `transport:"websocket"`，无 Webhook、频道或子频道接入。`/app/getAppAccessToken` 获取令牌，使用 `Authorization: QQBot ACCESS_TOKEN`。私聊白名单/绑定使用 `author.user_openid`；群绑定 `group_openid`，白名单使用 `author.member_openid`。

## 投递与恢复

接收 C2C 和群 @机器人文字，保留群内容原文，忽略机器人及不支持的消息类型；文字与富媒体类型（0 和 7）的附件作为持久任务字节保存，支持纯媒体。事件类型、消息 ID 和 scene 索引标识源事件，不保存临时 auth token。心跳/Identify/Resume 使用 `intents=1<<25`；游标接收成功才推进，失败阻止后续事件越过失败消息。会话和游标仅在进程内，重启不能保证重放；致命 Gateway 错误停止恢复。输出调用 `/v2/users/{openid}/messages` 或 `/v2/groups/{openid}/messages`，每片最多 2,000 UTF-8 字节。发送前持久分配分片 msg_seq，重试/重启复用，每个源最多 256 个分配。

## 参数与限制

被动回复私聊为 60 分钟/4 条，群为 5 分钟/5 条，均从平台时间戳计算，平台仍可提前拒绝。默认额度耗尽/过期即拒绝；`allowProactive:true` 可让新分片主动发送，仍需平台权限和用户/群接收偏好允许。已有被动分配和 API 拒绝不自动转换。重复被动错误 `40054005` 无可恢复回执，保留 unknown。`apiBase` 默认 `https://api.bot.qq.com`；`allowProactive` 默认 false；`maxReconnectAttempts` 为 0–1,000，默认 20；`allowInsecureLoopback` 默认 false。

## 账号变更

冻结应用 ID 和规范化 API 地址，令牌仅在内存缓存。

[媒体传输](../media.md)
