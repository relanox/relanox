# 渠道配置与协议参考

这里集中说明手写配置与协议细节。账号准备、平台权限、凭据获取和首条消息验证见[渠道指南](../channels/index.md)。

以下片段需要合并到完整配置的 `relay.accounts` 与 `relay.bindings` 中。替换示例 ID 和 Agent 名称，在服务环境中设置引用的环境变量。完整文件见[配置结构](configuration.md)。

## 目标可用条件 {#destinations}

会话绑定指定账号、`chatId` 和可选的 `threadId`，渠道通过原生协议解析该目标。配置的 ID、账号权限和平台条件充分时，可以在尚无来信的情况下发送。依赖事件的目标必须具备真实平台元数据；填写 ID 不会创建消息、回复窗口或消息串锚点。

| 渠道               | 原生目标和条件                                                                                                 |
| ------------------ | -------------------------------------------------------------------------------------------------------------- |
| Telegram           | 聊天 ID，有话题时还需话题 ID；机器人必须能访问该聊天。                                                         |
| Discord            | 频道 ID，有消息串时还需消息串频道 ID；机器人需要访问和发送权限。                                               |
| Slack              | 会话 ID；普通消息省略 `threadId`，消息串使用真实根消息的时间戳。                                               |
| 飞书 / Lark        | 聊天 ID；消息串还需要该目标已验证事件中的真实消息锚点。                                                        |
| 企业微信 WebSocket | 成员 userid 或群聊 ID；可通过 `recipientTypes` 在来信前指定 `single` 或 `group`。                              |
| 企业微信 HTTP      | 已验证的消息回调以及可用回复窗口；仅有聊天 ID 不足以发送。                                                     |
| 钉钉               | 员工 ID 或开放会话 ID；可通过 `recipientTypes` 指定 `single` 或 `group`，仍需独立发送消息 API 权限。           |
| QQ                 | 用户或群组 OpenID 及接收方类型。被动回复需真实来信且时间和额度仍有效；主动发送需 `allowProactive` 和平台权限。 |
| Microsoft Teams    | 会话 ID 和已验证的会话元数据，包括可信服务地址；安装或会话事件可在来信前建立目标。                             |
| WhatsApp           | 客户号码及 24 小时服务窗口内的真实来信；不支持窗口外的模板发送。                                               |
| Google Chat        | 完整空间名和可选消息串名；应用必须能访问该空间。                                                               |
| LINE               | 用户、群组或房间 ID，以及账号的推送消息权限和额度。                                                            |
| Matrix             | 已加入的房间 ID，以及可选消息串根事件 ID；只支持未加密房间。                                                   |
| Mattermost         | 频道 ID 和可选消息串根帖 ID；机器人必须能访问该频道。                                                          |
| Signal             | `direct:` 接收方或 `group:` ID，使用配置的 signal-cli 账号。                                                   |
| IRC                | 配置服务器上的频道或 `dm:<folded-nick>`；机器人必须已连接并加入配置的频道。                                    |

`recipientTypes` 是可选的账号 `config` 映射，以绑定中的准确 `chatId` 为键。企业微信 WebSocket、钉钉和 QQ 支持此配置；省略时可使用已验证消息中取得的接收方类型。该映射不会绕过平台权限、回复窗口或额度。企业微信、钉钉、QQ、WhatsApp、LINE、Signal 和 IRC 不支持 `threadId`。

本地协议测试验证地址解析和生成请求，不能证明真实账号兼容性。请按各渠道指南在平台上验证配置的账号。

## Markdown 回复 {#markdown}

Agent 回复文字统一使用 Markdown，无需选择格式模式。Relanox 使用平台原生 Markdown，或转换为该平台支持的格式。长回复按目标平台的长度限制分段，保留完整代码围栏、强调标记和链接地址。生成 HTML 或结构化格式时，原始 HTML 按文字显示。

| 渠道            | 发送格式                                                                   |
| --------------- | -------------------------------------------------------------------------- |
| Telegram        | 使用 UTF-16 偏移的消息和说明文字实体，支持粗体、斜体、删除线、代码及链接。 |
| Discord         | 原生消息 Markdown。                                                        |
| Slack           | 结构化富文本块，表达强调、代码和链接。                                     |
| 飞书 / Lark     | 包含 Markdown 元素的富文本消息。                                           |
| 企业微信        | 原生 Markdown；回调模式合并发送最终文字和支持的图片。                      |
| 钉钉            | `sampleMarkdown` 机器人消息。                                              |
| QQ              | Markdown 消息（`msg_type: 2`）。                                           |
| Microsoft Teams | 扩展 Markdown 消息。                                                       |
| WhatsApp        | 原生粗体、斜体、删除线和等宽语法，链接保留 URL。                           |
| Google Chat     | 声明 `MARKUP_SYNTAX_MARKDOWN` 的消息。                                     |
| LINE            | Flex 文字组件与文本片段，使用支持的强调样式和链接动作。                    |
| Matrix          | 在 `formatted_body` 中发送经过转义的 HTML，并保留协议要求的源文字 `body`。 |
| Mattermost      | 原生帖子 Markdown。                                                        |
| Signal          | 原生文字样式范围，链接保留 URL。                                           |
| IRC             | 原生格式控制符，完整命令保持在协议长度限制以内。                           |

显示效果因客户端而异。样式较少的平台会保留标题、列表和表格中的文字，代码和链接使用可用的表达方式。Markdown 图片语法不会上传文件，发送媒体请使用附件。企业微信回调等合并回复的限制会在入队前检查。

原生协议见[飞书富文本](https://open.feishu.cn/document/server-docs/im-v1/message-content-description/create_json)、[钉钉机器人消息](https://open.dingtalk.com/document/development/robot-message-type)、[Teams 格式](https://learn.microsoft.com/en-us/microsoftteams/platform/bots/how-to/format-your-bot-messages)和 [Matrix 格式化消息](https://spec.matrix.org/latest/client-server-api/#mroommessage)。本地 HTTP 与 socket 测试验证实际生成的协议请求，不代表已经验证真实账号兼容性。

## 钉钉应用机器人 {#dingtalk}

用户操作：[配置 钉钉应用机器人](../channels/dingtalk.md)。

```json
{
  "accounts": [
    {
      "id": "dingtalk-main",
      "channel": "dingtalk",
      "allowedSenders": ["$:LWCP_v1:opaque-platform-sender-id"],
      "config": {
        "clientId": "application-client-id",
        "clientSecret": {
          "env": "DINGTALK_APP_SECRET"
        },
        "robotCode": "application-robot-code",
        "recipientTypes": {
          "staff-user-id": "single",
          "open-conversation-id": "group"
        }
      }
    }
  ],
  "bindings": [
    {
      "accountId": "dingtalk-main",
      "chatId": "staff-user-id",
      "endpointId": "my-agent"
    }
  ]
}
```

`recipientTypes` 中的条目使账号能在尚无来信时寻址对应的已绑定员工或群组。`single` 使用员工 ID，`group` 使用开放会话 ID。

## Discord {#discord}

用户操作：[配置 Discord](../channels/discord.md)。

```json
{
  "accounts": [
    {
      "id": "discord-main",
      "channel": "discord",
      "allowedSenders": ["123456789012345678"],
      "config": {
        "botToken": {
          "env": "DISCORD_BOT_TOKEN"
        }
      }
    }
  ],
  "bindings": [
    {
      "accountId": "discord-main",
      "chatId": "112233445566778899",
      "endpointId": "my-agent"
    }
  ]
}
```

会话绑定按会话和消息串 ID 精确匹配。测试消息包含消息串 ID 时，需要填写 「话题 / 线程 ID」；省略它时匹配没有消息串 ID 的消息。

Relanox 启动时会自动查询机器人身份和 Gateway 地址。

## 飞书 / Lark {#feishu}

用户操作：[配置 飞书 / Lark](../channels/feishu.md)。

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

会话绑定按会话和消息串 ID 精确匹配。测试消息包含消息串 ID 时，需要填写 「话题 / 线程 ID」；省略它时匹配没有消息串 ID 的消息。

Relanox 启动时会自动查询机器人 open ID。

消息串还需要从已验证事件取得的消息锚点，且账号、聊天和消息串必须匹配。仅配置 `threadId` 无法建立锚点；普通会话发送直接使用聊天 ID。

生成的音频需为 Opus/Ogg 并带时长，视频需为 MP4 并带时长。

## Google Chat {#googlechat}

用户操作：[配置 Google Chat](../channels/googlechat.md)。

```json
{
  "accounts": [
    {
      "id": "googlechat-main",
      "config": {
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

会话绑定按会话和消息串 ID 精确匹配。测试消息包含消息串 ID 时，需要填写 「话题 / 线程 ID」；省略它时匹配没有消息串 ID 的消息。

Relanox 会从 `publicUrl` 和账号 ID 自动推导预期 audience；

Relanox 验证调用者邮箱为 `chat@system.gserviceaccount.com`。

## IRC {#irc}

用户操作：[配置 IRC](../channels/irc.md)。

```json
{
  "accounts": [
    {
      "id": "irc-main",
      "config": {
        "server": "irc.example.com",
        "port": 6697,
        "tls": true,
        "nick": "relanox",
        "sasl": {
          "username": "relanox",
          "password": {
            "env": "IRC_SASL_PASSWORD"
          }
        }
      },
      "channel": "irc",
      "allowedSenders": ["account:alice"]
    }
  ],
  "bindings": [
    {
      "accountId": "irc-main",
      "chatId": "#support",
      "endpointId": "my-agent"
    }
  ]
}
```

使用昵称身份的网络可由管理员显式启用 `allowNickFallback:true`，并允许 `nick:<folded-nick>`；仅在访问策略可接受昵称归属变化时使用。

## LINE {#line}

用户操作：[配置 LINE](../channels/line.md)。

```json
{
  "accounts": [
    {
      "id": "line-main",
      "config": {
        "channelSecret": {
          "env": "LINE_CHANNEL_SECRET"
        },
        "accessToken": {
          "env": "LINE_ACCESS_TOKEN"
        }
      },
      "channel": "line",
      "allowedSenders": ["U_example_user"]
    }
  ],
  "bindings": [
    {
      "accountId": "line-main",
      "chatId": "G_example_group",
      "endpointId": "my-agent"
    }
  ]
}
```

Relanox 启动时会使用 Access Token 自动查询机器人身份。

Relanox 会用自动查询的机器人身份校验回调的 `destination`。

## Matrix {#matrix}

用户操作：[配置 Matrix](../channels/matrix.md)。

```json
{
  "accounts": [
    {
      "id": "matrix-main",
      "config": {
        "homeserver": "https://matrix.example.com",
        "accessToken": {
          "env": "MATRIX_ACCESS_TOKEN"
        }
      },
      "channel": "matrix",
      "allowedSenders": ["@alice:example.com"]
    }
  ],
  "bindings": [
    {
      "accountId": "matrix-main",
      "chatId": "!support:example.com",
      "endpointId": "my-agent"
    }
  ]
}
```

会话绑定按会话和消息串 ID 精确匹配。测试消息包含消息串 ID 时，需要填写 「话题 / 线程 ID」；省略它时匹配没有消息串 ID 的消息。

Relanox 启动时会自动查询该账号的用户 ID。

## Mattermost {#mattermost}

用户操作：[配置 Mattermost](../channels/mattermost.md)。

```json
{
  "accounts": [
    {
      "id": "mattermost-main",
      "config": {
        "serverUrl": "https://mattermost.example.com",
        "token": {
          "env": "MATTERMOST_TOKEN"
        }
      },
      "channel": "mattermost",
      "allowedSenders": ["dedicated_sender_id"]
    }
  ],
  "bindings": [
    {
      "accountId": "mattermost-main",
      "chatId": "dedicated_channel_id",
      "endpointId": "my-agent"
    }
  ]
}
```

会话绑定按会话和消息串 ID 精确匹配。测试消息包含消息串 ID 时，需要填写 「话题 / 线程 ID」；省略它时匹配没有消息串 ID 的消息。

Relanox 启动时会自动查询机器人用户 ID。

## Microsoft Teams {#msteams}

用户操作：[配置 Microsoft Teams](../channels/msteams.md)。

```json
{
  "accounts": [
    {
      "id": "msteams-main",
      "config": {
        "appId": "microsoft_application_id",
        "botId": "28:bot_activity_recipient_id",
        "tenantId": "allowed_teams_tenant_id",
        "appSecret": {
          "env": "TEAMS_APP_SECRET"
        },
        "trustedServiceOrigins": ["https://smba.trafficmanager.net"]
      },
      "channel": "msteams",
      "allowedSenders": ["29:teams-user-id"]
    }
  ],
  "bindings": [
    {
      "accountId": "msteams-main",
      "chatId": "teams-conversation-id",
      "endpointId": "my-agent"
    }
  ]
}
```

会话绑定按会话和消息串 ID 精确匹配。测试消息包含消息串 ID 时，需要填写 「话题 / 线程 ID」；省略它时匹配没有消息串 ID 的消息。

Relanox 从已验证的 `message`、`conversationUpdate` 和 `installationUpdate` Activity 保存原生会话元数据，要求发送者已获允许，且机器人和租户匹配。安装或会话事件可在第一条消息前建立目标。保存的服务 URL 仍必须匹配 `trustedServiceOrigins`；会话绑定不会授权任意服务 URL。

## QQ 机器人 {#qq}

用户操作：[配置 QQ 机器人](../channels/qq.md)。

```json
{
  "accounts": [
    {
      "id": "qq-main",
      "channel": "qq",
      "allowedSenders": ["user-openid", "group-member-openid"],
      "config": {
        "appId": "123456789",
        "clientSecret": {
          "env": "QQ_CLIENT_SECRET"
        },
        "allowProactive": false,
        "recipientTypes": {
          "user-openid": "c2c",
          "group-openid": "group"
        }
      }
    }
  ],
  "bindings": [
    {
      "accountId": "qq-main",
      "chatId": "user-openid",
      "endpointId": "my-agent"
    }
  ]
}
```

QQ 默认使用正式环境。需要沙箱时，在账号配置中加入 `"environment": "sandbox"`。Relanox 会自动选择原生 API 和令牌地址。

`recipientTypes` 标识私聊和群聊目标。`allowProactive: false` 时仍需真实来信：私聊回复窗口为 60 分钟、4 条额度，群聊为 5 分钟、5 条额度。文字和每个附件分别占用额度。没有来信时发送，需已知的接收方类型、`allowProactive: true`、平台权限和目标的接收许可。

## Signal 与 signal-cli {#signal}

用户操作：[配置 Signal 与 signal-cli](../channels/signal.md)。

```json
{
  "accounts": [
    {
      "id": "signal-main",
      "config": {
        "serviceUrl": "https://signal-bridge.example.com",
        "account": "+15551234567",
        "authorization": {
          "env": "SIGNAL_BRIDGE_AUTHORIZATION"
        }
      },
      "channel": "signal",
      "allowedSenders": ["11111111-1111-4111-8111-111111111111"]
    }
  ],
  "bindings": [
    {
      "accountId": "signal-main",
      "chatId": "direct:11111111-1111-4111-8111-111111111111",
      "endpointId": "my-agent"
    }
  ]
}
```

### 协议与命令细节

Relanox 会按账号号码过滤自身消息。如果服务发出的自身消息只带 UUID，可另外设置 `selfUuid` 为该账号 UUID，以便同样过滤。

同机服务可使用 HTTP 回环地址并添加 `allowInsecureLocalhost:true`；本地服务无需认证时移除 `authorization`。

## Slack {#slack}

用户操作：[配置 Slack](../channels/slack.md)。

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

会话绑定按会话和消息串 ID 精确匹配。测试消息包含消息串 ID 时，需要填写 「话题 / 线程 ID」；省略它时匹配没有消息串 ID 的消息。

Relanox 启动时会用机器人 Token 自动查询工作区和机器人用户 ID。

机器人 Token 调用 `auth.test` 可取得工作区和机器人用户身份。

示例使用真实根消息时间戳绑定特定消息串。省略 `threadId` 时，绑定普通频道或私聊消息，直接向该会话发送。普通来信没有消息串 ID；只有带 `thread_ts` 的回复会匹配消息串绑定。

## Telegram {#telegram}

用户操作：[配置 Telegram](../channels/telegram.md)。

```json
{
  "accounts": [
    {
      "id": "telegram-main",
      "channel": "telegram",
      "allowedSenders": ["123456789"],
      "config": {
        "botToken": {
          "env": "TELEGRAM_BOT_TOKEN"
        },
        "webhookSecret": {
          "env": "TELEGRAM_WEBHOOK_SECRET"
        }
      }
    }
  ],
  "bindings": [
    {
      "accountId": "telegram-main",
      "chatId": "123456789",
      "endpointId": "my-agent"
    }
  ]
}
```

会话绑定按会话和消息串 ID 精确匹配。测试消息包含消息串 ID 时，需要填写 「话题 / 线程 ID」；省略它时匹配没有消息串 ID 的消息。

## 企业微信智能机器人 {#wecom}

用户操作：[配置 企业微信智能机器人](../channels/wecom.md)。

```json
{
  "accounts": [
    {
      "id": "wecom-main",
      "channel": "wecom",
      "allowedSenders": ["staff-userid"],
      "config": {
        "mode": "websocket",
        "botId": "intelligent-robot-id",
        "secret": {
          "env": "WECOM_BOT_SECRET"
        },
        "recipientTypes": {
          "staff-userid": "single",
          "group-chatid": "group"
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

`mode` 默认为 `websocket`。可选的 `recipientTypes` 映射让 WebSocket 在来信前寻址已绑定的成员或群组。使用 HTTP 回调时，将上方账号的 `config` 替换为：

```json
{
  "mode": "webhook",
  "botId": "intelligent-robot-id",
  "token": { "env": "WECOM_TOKEN" },
  "encodingAESKey": { "env": "WECOM_ENCODING_AES_KEY" }
}
```

在公网 HTTPS 地址下注册 `/channels/{accountId}/webhook`。已验证的消息回调建立回复目标；填写聊天 ID 无法创建该目标。回调使用[企业微信被动回复协议](https://developer.work.weixin.qq.com/document/path/101031)：首次返回签名加密响应并提供 `stream.id`，随后通过已验证的 `msgtype: "stream"` 刷新回调取得一次完整最终回复。回复和图片持久化保存，进程重启后仍可继续刷新。`finish: true` 的响应包含 Markdown `content`，以及最多 10 个带 Base64 图片数据和原始字节 MD5 的 `msg_item`。文字上限为 20,480 个 UTF-8 字节；当前实现接受 10 MiB 内的 PNG/JPEG 图片，等待回复保留十分钟。最终刷新返回前，投递状态保持等待；重复刷新返回同一最终回复。此 HTTP 回复协议不支持发送音频、视频和文件。`recipientTypes` 和下方 WebSocket 发现命令不适用于回调账号。

### 协议与命令细节

首次配置时，先将企业微信条目保存到 `relanox.json` 草稿的 `relay.accounts`，填写真实 `botId` 和密钥环境变量引用。发现期间可以将 `allowedSenders` 留空、暂不完成绑定。在终端环境中设置 `WECOM_BOT_SECRET`；此命令不需要 Agent 凭据或数据库配置。

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

发现命令目前只支持企业微信，默认 120 秒后停止；`--timeout` 接受 1–600 秒，也可按 Ctrl+C 提前停止。终端只显示账号、会话与发送者 ID，不包含消息正文、媒体 URL 或凭据。命令不下载附件、不保存消息，也不向 Agent 派发。正常服务仍要求完成绑定与发送者允许列表。补全配置后运行 `node apps/cli/dist/main.js validate --config relanox.json`，再启动服务。

连接地址：`wss://openws.work.weixin.qq.com`。

## WhatsApp Business {#whatsapp}

用户操作：[配置 WhatsApp Business](../channels/whatsapp.md)。

```json
{
  "accounts": [
    {
      "id": "whatsapp-main",
      "config": {
        "phoneNumberId": "your_phone_number_id",
        "businessAccountId": "your_whatsapp_business_account_id",
        "appSecret": {
          "env": "WHATSAPP_APP_SECRET"
        },
        "verifyToken": {
          "env": "WHATSAPP_VERIFY_TOKEN"
        },
        "accessToken": {
          "env": "WHATSAPP_ACCESS_TOKEN"
        }
      },
      "channel": "whatsapp",
      "allowedSenders": ["15551234567"]
    }
  ],
  "bindings": [
    {
      "accountId": "whatsapp-main",
      "chatId": "15551234567",
      "endpointId": "my-agent"
    }
  ]
}
```

### 协议与命令细节

Relanox 使用 Graph API `v25.0`，支持的 API 版本由 Relanox 版本统一管理。
