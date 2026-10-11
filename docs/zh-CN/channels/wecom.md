# 企业微信智能机器人

在企业微信私聊和群聊中使用智能机器人。

## 准备账号

创建并启用可使用长连接的智能机器人，记录 Bot ID，将密钥保存到 `WECOM_BOT_SECRET`。向所需成员开放机器人，并将它加入目标群组。同一个机器人运行一个 Relanox 进程。

## 添加配置

将下方条目加入现有配置的 `relay.accounts` 和 `relay.bindings`。这是配置片段，需要合并进完整配置文件。将示例 ID 和 `my-agent` 替换为你的实际 ID 与[已配置 Agent 连接](../agents.md)。在启动 Relanox 的环境中设置所引用的全部环境变量，保存后重启。完整文件写法见[配置](../configuration.md)。

```json
{
  "accounts": [
    {
      "id": "wecom-main",
      "channel": "wecom",
      "allowedSenders": ["staff-userid"],
      "config": {
        "botId": "intelligent-robot-id",
        "secret": {
          "env": "WECOM_BOT_SECRET"
        }
      }
    }
  ],
  "bindings": [
    {
      "accountId": "wecom-main",
      "chatId": "staff-userid",
      "endpointId": "my-agent"
    }
  ]
}
```

## 发现用户和群组 ID

首次配置时，先将企业微信条目保存到 `relanox.json` 草稿的 `relay.accounts`，填写真实 `botId` 和密钥环境变量引用。发现期间可以将 `allowedSenders` 留空、暂不完成绑定。在终端环境中设置 `WECOM_BOT_SECRET`；此命令不需要 Agent 凭据或数据库配置。

开始前先停止使用同一机器人的服务：企业微信会在新进程连接时替换原有连接。运行：

```sh
relanox discover --config relanox.json --account wecom-main --timeout 120
```

等待终端显示 `discovery_connected` 事件，再向机器人发送私聊消息，或在目标群中 @ 机器人。终端会为每个不同的会话和发送者打印一行 JSON：

```json
{
  "ok": true,
  "event": "conversation",
  "accountId": "wecom-main",
  "channel": "wecom",
  "chatId": "group-chatid",
  "senderId": "staff-userid"
}
```

将 `senderId` 填入 `allowedSenders`，将 `chatId` 填入绑定。私聊使用成员 userid，群聊使用已认证回调中的 `chatid`。需要其他成员的 userid 时，让相应成员各发送一条消息。使用这些 ID，而非显示名称。

发现命令目前只支持企业微信，默认 120 秒后停止；`--timeout` 接受 1–600 秒，也可按 Ctrl+C 提前停止。终端只显示账号、会话与发送者 ID，不包含消息正文、媒体 URL 或凭据。命令不下载附件、不保存消息，也不向 Agent 派发。正常服务仍要求完成绑定与发送者允许列表。补全配置后运行 `relanox validate --config relanox.json`，再启动服务。

## 启用连接

启动 Relanox 后会自动连接 `wss://openws.work.weixin.qq.com`。保持进程运行。

## 发送第一条消息

向机器人私聊发送“你好”。在绑定群组中 @ 机器人提问，并确认你的企业成员 userid 已获允许。

## 图片和文件

可发送图片、视频、文件或图文混合消息；语音输入会将识别文字交给 Agent。媒体下载资源五分钟后过期，发送时保持 Relanox 在线。回复可包含 10 MiB 内的 PNG/JPEG/GIF 图片和 MP4 视频、2 MiB 内的 AMR 音频、20 MiB 内的文件，同时受 Relanox 限制。

## 常见问题

连接被替换时，停止使用同一机器人的其他进程，再重启本实例。群组提问没有响应时，检查机器人是否在群内并 @ 它。更换密钥后更新服务的环境变量，再重启服务。

发现命令未输出会话时，核对 Bot ID 与密钥、成员访问权限和群组成员关系，并在命令运行期间重新发送消息。仅正常超时退出不能证明平台认证成功。
