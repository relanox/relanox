# Slack

通过 Slack 应用，在频道、私聊和消息串中使用 Agent。

## 准备账号

创建并安装工作区应用，将机器人 Token 和签名密钥分别保存到 `SLACK_BOT_TOKEN`、`SLACK_SIGNING_SECRET`。记录应用 ID；Relanox 启动时会用机器人 Token 自动查询工作区和机器人用户 ID。授予 `chat:write`、所用会话对应的消息历史权限；文件需要 `files:read` 和 `files:write`。将应用邀请到所选频道。

## 添加配置

将下方条目加入现有配置的 `relay.accounts` 和 `relay.bindings`。这是配置片段，需要合并进完整配置文件。将示例 ID 和 `my-agent` 替换为你的实际 ID 与[已配置 Agent 连接](../agents.md)。在启动 Relanox 的环境中设置所引用的全部环境变量，保存后重启。完整文件写法见[配置](../configuration.md)。

```json
{
  "accounts": [
    {
      "id": "slack-main",
      "channel": "slack",
      "allowedSenders": ["U123ABC"],
      "config": {
        "botToken": {
          "env": "SLACK_BOT_TOKEN"
        },
        "signingSecret": {
          "env": "SLACK_SIGNING_SECRET"
        },
        "appId": "A123ABC"
      }
    }
  ],
  "bindings": [
    {
      "accountId": "slack-main",
      "chatId": "C123ABC",
      "endpointId": "my-agent",
      "threadId": "1710000000.000001"
    }
  ]
}
```

打开成员资料并复制成员 ID，填入 `allowedSenders`。打开频道详情复制频道 ID，填入 `chatId`；私聊会话 ID 可通过应用的会话信息 API 取得。机器人 Token 调用 `auth.test` 可取得工作区和机器人用户身份。将所选消息串根消息的 `ts` 填入 `threadId`；该消息串的回复中它表现为 `thread_ts`。先创建一条根消息并复制消息链接。链接若以 `p1710000000000001` 结尾，根消息时间戳就是 `1710000000.000001`（在最后六位前加小数点）。把该时间戳填入 `threadId`，保存配置并重启 Relanox，再在该消息串中回复。每条接收的 Slack 消息都有消息串 ID，每个消息串需要对应的精确绑定。

会话绑定按会话和消息串 ID 精确匹配。测试消息包含消息串 ID 时，需要填写 `threadId`；省略它时匹配没有消息串 ID 的消息。

## 启用连接

HTTP 接收方式：将事件请求地址设为 `https://relay.example.com/channels/slack-main/events`，按需订阅 `message.channels`、`message.groups`、`message.im`、`message.mpim` 或 `app_mention`。Slack 验证地址前先启动 Relanox。也可启用 Socket Mode，用 `appToken: {"env":"SLACK_APP_TOKEN"}` 替换 `signingSecret`，并为 App Token 授予 `connections:write`；此时 Relanox 自动建立连接。`signingSecret` 和 `appToken` 只填写其中一个，Relanox 会据此选择接收方式。

## 发送第一条消息

在配置的消息串中回复“你好”，或根据订阅的事件 @ 应用。回复出现在消息串中，请打开消息串查看。

## 图片和文件

发送问题时可分享图片、音频、视频或文件。生成文件会发回同一频道或消息串。确认已安装的机器人 Token 具备两个文件权限；修改权限后重新安装应用。

## 常见问题

地址验证失败时，检查公网事件地址和签名密钥。频道消息缺失时，检查事件订阅和应用是否在频道内。Socket Mode 连接失败时，核对 App Token 和 `connections:write`，更新环境变量后重启 Relanox。
