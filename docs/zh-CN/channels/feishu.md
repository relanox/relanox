# 飞书 / Lark

将飞书或 Lark 的企业自建应用机器人连接到 Agent。

## 准备账号

创建企业自建应用，启用机器人能力，授予接收消息、发送消息和资源访问权限。记录 App ID 和 tenant key；Relanox 启动时会自动查询机器人 open ID。将应用密钥、事件 Verification Token 和 Encrypt Key 存入下方环境变量。Lark 用户将 `domain` 改为 `"lark"`。

## 添加配置

将下方条目加入现有配置的 `relay.accounts` 和 `relay.bindings`。这是配置片段，需要合并进完整配置文件。将示例 ID 和 `my-agent` 替换为你的实际 ID 与[已配置 Agent 连接](../agents.md)。在启动 Relanox 的环境中设置所引用的全部环境变量，保存后重启。完整文件写法见[配置](../configuration.md)。

```json
{
  "accounts": [
    {
      "id": "feishu-main",
      "channel": "feishu",
      "allowedSenders": ["ou_example_user"],
      "config": {
        "appId": "cli_example",
        "appSecret": {
          "env": "FEISHU_APP_SECRET"
        },
        "verificationToken": {
          "env": "FEISHU_VERIFICATION_TOKEN"
        },
        "encryptKey": {
          "env": "FEISHU_ENCRYPT_KEY"
        },
        "tenantKey": "example-tenant",
        "domain": "feishu"
      }
    }
  ],
  "bindings": [
    {
      "accountId": "feishu-main",
      "chatId": "oc_example_chat",
      "endpointId": "my-agent"
    }
  ]
}
```

请机器人管理员准备下面列出的用户和会话 ID，再填写配置。管理员可以从已有的机器人消息记录中核对这些值。使用平台分配的 ID，而非聊天中显示的名称。

消息事件的发送者 `open_id` 填入 `allowedSenders`，`message.chat_id` 填入 `chatId`。事件头中可取得 `tenant_key`，机器人身份可通过机器人信息 API 取得。消息串绑定使用 `message.thread_id`；事件以 `root_id` 标识消息串时使用该值。

会话绑定按会话和消息串 ID 精确匹配。测试消息包含消息串 ID 时，需要填写 `threadId`；省略它时匹配没有消息串 ID 的消息。

## 启用连接

使用事件订阅 v2.0，将地址填为 `https://relay.example.com/channels/feishu-main/events`，订阅 `im.message.receive_v1`，并配置相同的 Verification Token 和 Encrypt Key。验证回调前启动 Relanox，然后发布应用变更，向使用者开放机器人。

## 发送第一条消息

打开与机器人的会话，或将它加入绑定群组并 @ 它发送“你好”。发送者需在应用可用范围和允许发送者列表内。

## 图片和文件

提问时可发送图片、音频、视频、文件或富文本消息。授予资源下载和上传权限，如 `im:resource` 或适用的上传权限。回复图片上传上限为 10 MiB，其他上传为 30 MiB，同时受 Relanox 限制。生成的音频需为 Opus/Ogg 并带时长，视频需为 MP4 并带时长。

## 常见问题

回调验证失败时，核对双方 Token 和 Encrypt Key。部分用户无法使用机器人时，检查已发布应用的可用范围。媒体传输失败时，检查资源权限，并按企业要求重新安装或发布权限变更。
