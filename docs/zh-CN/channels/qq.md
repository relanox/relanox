# QQ 私聊与群文字

将下列对象放入账号的 `config`。账号 ID、白名单、Agent 绑定及环境变量密钥引用见[配置说明](../configuration.md)，目标 Agent 见 [Agent 接入](../agents.md)。

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

接收 C2C 和群 @机器人文字，保留群内容原文，忽略机器人、附件和非零 `message_type`。事件类型、消息 ID 和 scene 索引标识源事件，不保存临时 auth token。心跳/Identify/Resume 使用 `intents=1<<25`；游标接收成功才推进，失败阻止后续事件越过失败消息。会话和游标仅在进程内，重启不能保证重放；致命 Gateway 错误停止恢复。输出调用 `/v2/users/{openid}/messages` 或 `/v2/groups/{openid}/messages`，每片最多 2,000 UTF-8 字节。发送前持久分配分片 msg_seq，重试/重启复用，每个源最多 256 个分配。

## 参数与限制

被动回复私聊为 60 分钟/4 条，群为 5 分钟/5 条，均从平台时间戳计算，平台仍可提前拒绝。默认额度耗尽/过期即拒绝；`allowProactive:true` 可让新分片主动发送，仍需平台权限和用户/群接收偏好允许。已有被动分配和 API 拒绝不自动转换。重复被动错误 `40054005` 无可恢复回执，保留 unknown。`apiBase` 默认 `https://api.bot.qq.com`；`allowProactive` 默认 false；`maxReconnectAttempts` 为 0–1,000，默认 20；`allowInsecureLoopback` 默认 false。

## 账号变更

冻结应用 ID 和规范化 API 地址，令牌仅在内存缓存。 同一身份可轮换密钥；恢复旧投递前须恢复匹配配置，缺少身份范围的旧目标不能自动重绑定。

本渠道不声明持久外部幂等保证。安全传输、重试和 unknown 结果的人工恢复见[配置说明](../configuration.md)。
