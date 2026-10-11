# Google Chat

通过 Google Chat HTTP 应用，在空间和消息串中使用 Agent。

## 准备账号

在 Google Cloud 项目启用 Chat API，配置 Chat 应用并创建其服务账号。将完整服务账号 JSON 保存到 `GOOGLE_CHAT_SERVICE_ACCOUNT_JSON`。使用 `chat.bot` 权限的应用认证。按照组织策略开放应用，并将它加入目标空间。

## 添加配置

将下方条目加入现有配置的 `relay.accounts` 和 `relay.bindings`。这是配置片段，需要合并进完整配置文件。将示例 ID 和 `my-agent` 替换为你的实际 ID 与[已配置 Agent 连接](../agents.md)。在启动 Relanox 的环境中设置所引用的全部环境变量，保存后重启。完整文件写法见[配置](../configuration.md)。

```json
{
  "accounts": [
    {
      "id": "googlechat-main",
      "config": {
        "audience": "https://relay.example.com/channels/googlechat-main/webhook",
        "serviceAccount": {
          "env": "GOOGLE_CHAT_SERVICE_ACCOUNT_JSON"
        }
      },
      "channel": "googlechat",
      "allowedSenders": ["users/123456789"]
    }
  ],
  "bindings": [
    {
      "accountId": "googlechat-main",
      "chatId": "spaces/AAAAExample",
      "endpointId": "my-agent",
      "threadId": "spaces/AAAAExample/threads/BBBBExample"
    }
  ]
}
```

请机器人管理员准备下面列出的用户和会话 ID，再填写配置。管理员可以从已有的机器人消息记录中核对这些值。使用平台分配的 ID，而非聊天中显示的名称。

从消息事件取得发送者资源名（`users/<id>`）填入 `allowedSenders`、空间名（`spaces/<id>`）填入 `chatId`、消息串名（`spaces/<id>/threads/<id>`）填入指定的 `threadId`。复制完整资源名。示例绑定一个精确的空间/消息串组合。收到的消息含消息串时，其完整名称必须与 `threadId` 一致。需要使用其他消息串时，分别添加对应绑定。

会话绑定按会话和消息串 ID 精确匹配。测试消息包含消息串 ID 时，需要填写 `threadId`；省略它时匹配没有消息串 ID 的消息。

## 启用连接

将应用 HTTP 端点设为 `https://relay.example.com/channels/googlechat-main/webhook`。应用认证 audience 和账号的 `audience` 均填写这一完整地址。发送应用交互前启动 Relanox。Relanox 验证调用者邮箱为 `chat@system.gserviceaccount.com`。

## 发送第一条消息

在配置的空间/消息串中 @ 已安装应用并发送“你好”。私聊也需先按其消息事件中的实际空间和消息串字段完成绑定。打开同一消息串查看回答。

## 图片和文件

提问时可直接上传附件到 Chat。接收生成媒体需按[媒体](../media.md)配置 `media.publicBaseUrl`。图片回复显示为卡片，音频、视频和文件显示为带名称的下载按钮。公网媒体地址需让收件者访问，并供 Google 获取图片。

## 常见问题

认证错误时，核对 `audience` 与完整端点地址，包括账号 ID 和路径。发送失败时，检查服务账号 JSON、Chat API 和应用是否在空间内。图片或下载不可用时，检查公网媒体地址。需要 Agent 读取文件内容时，将文件直接上传到 Chat。
