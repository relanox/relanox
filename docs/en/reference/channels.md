# Channel configuration and protocol reference

This chapter contains manual configuration and protocol details. For account preparation, platform permissions, credentials and your first reply, use the [channel guides](../channels/index.md).

Merge these fragments into `relay.accounts` and `relay.bindings` in a complete configuration. Replace sample IDs and Agent names and set referenced environment variables in the service environment. See [Configuration schema](configuration.md) for the complete file.

## DingTalk application robot {#dingtalk}

User setup: [Connect DingTalk application robot](../channels/dingtalk.md).

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
        "robotCode": "application-robot-code"
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

Generated audio needs a duration; video also needs an image preview and a duration.

## Discord {#discord}

User setup: [Connect Discord](../channels/discord.md).

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

Bindings match the exact chat and thread IDs. Include **Thread ID** when your test message has one; omitting it selects messages without a thread ID.

### Protocol and command details

Relanox discovers the bot identity and Gateway address at startup.

## Feishu / Lark {#feishu}

User setup: [Connect Feishu / Lark](../channels/feishu.md).

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

Bindings match the exact chat and thread IDs. Include **Thread ID** when your test message has one; omitting it selects messages without a thread ID.

### Protocol and command details

Relanox discovers the bot open ID at startup.

Generated audio needs Opus/Ogg and a duration; video needs MP4 and a duration.

## Google Chat {#googlechat}

User setup: [Connect Google Chat](../channels/googlechat.md).

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

Bindings match the exact chat and thread IDs. Include **Thread ID** when your test message has one; omitting it selects messages without a thread ID.

### Protocol and command details

Relanox verifies the caller email as `chat@system.gserviceaccount.com`.

Relanox derives the expected audience from `publicUrl` and this account’s ID; replace `googlechat-main` in the endpoint path if you renamed the account.

## IRC {#irc}

User setup: [Connect IRC](../channels/irc.md).

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

For networks using nicknames, an administrator can explicitly enable `allowNickFallback:true` and allow `nick:<folded-nick>`; use this only when nickname ownership is acceptable for your access policy.

## LINE {#line}

User setup: [Connect LINE](../channels/line.md).

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

### Protocol and command details

Relanox discovers the bot identity from the access token at startup.

Relanox checks webhook destinations against the discovered bot identity.

## Matrix {#matrix}

User setup: [Connect Matrix](../channels/matrix.md).

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

Bindings match the exact chat and thread IDs. Include **Thread ID** when your test message has one; omitting it selects messages without a thread ID.

### Protocol and command details

Relanox discovers the account’s user ID at startup.

## Mattermost {#mattermost}

User setup: [Connect Mattermost](../channels/mattermost.md).

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

Bindings match the exact chat and thread IDs. Include **Thread ID** when your test message has one; omitting it selects messages without a thread ID.

### Protocol and command details

Relanox discovers its user ID at startup.

## Microsoft Teams {#msteams}

User setup: [Connect Microsoft Teams](../channels/msteams.md).

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

Bindings match the exact chat and thread IDs. Include **Thread ID** when your test message has one; omitting it selects messages without a thread ID.

For a single-tenant bot, set `tokenUrl` to `https://login.microsoftonline.com/<application-tenant-id>/oauth2/v2.0/token`. This application tenant may differ from the allowed Teams tenant in `tenantId`. The channel uses public-cloud Bot Framework authentication.

## QQ robot {#qq}

User setup: [Connect QQ robot](../channels/qq.md).

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
        "allowProactive": false
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

QQ uses the production environment by default. For the sandbox, add `"environment": "sandbox"` to the account configuration. Relanox selects the native API and token endpoints automatically.

## Signal with signal-cli {#signal}

User setup: [Connect Signal with signal-cli](../channels/signal.md).

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

### Protocol and command details

Relanox filters self-messages by account number. If your daemon sends self-messages identified only by UUID, optionally set `selfUuid` to that account’s UUID for the same filtering.

For a daemon on the same machine, use an HTTP loopback URL and add `allowInsecureLocalhost:true`; remove `authorization` if that local daemon does not require it.

## Slack {#slack}

User setup: [Connect Slack](../channels/slack.md).

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

Bindings match the exact chat and thread IDs. Include **Thread ID** when your test message has one; omitting it selects messages without a thread ID.

### Protocol and command details

Relanox discovers the workspace and bot user IDs from the bot token at startup. Bot `auth.test` can also identify them.

## Telegram {#telegram}

User setup: [Connect Telegram](../channels/telegram.md).

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

Bindings match the exact chat and thread IDs. Include **Thread ID** when your test message has one; omitting it selects messages without a thread ID.

## WeCom intelligent robot {#wecom}

User setup: [Connect WeCom intelligent robot](../channels/wecom.md).

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

Omitting `mode` keeps the existing WebSocket configuration valid. For HTTP callback mode, replace the account `config` above with:

```json
{
  "mode": "webhook",
  "botId": "intelligent-robot-id",
  "token": { "env": "WECOM_TOKEN" },
  "encodingAESKey": { "env": "WECOM_ENCODING_AES_KEY" }
}
```

Register `/channels/{accountId}/webhook` on your public HTTPS origin. Relanox supports one text reply per incoming message, within one hour, and limits the reply to 2,048 UTF-8 bytes before Markdown escaping. Longer replies are rejected before enqueueing; media replies are unavailable. The WebSocket discovery command below does not apply to callback accounts. For platform details, see [WeCom active replies](https://developer.work.weixin.qq.com/document/path/101138).

### Protocol and command details

For first-time setup, save a draft `relanox.json` containing your WeCom entry in `relay.accounts`, with the real `botId` and secret environment reference. You can leave `allowedSenders` empty and bindings unfinished during discovery. Set `WECOM_BOT_SECRET` in the terminal environment. Agent credentials and database setup are not needed for this command.

Wait for the terminal's `discovery_connected` event, then send a message directly to the robot, or mention it in the target group. The terminal prints a JSON line for each distinct conversation and sender:

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

Discovery supports WeCom only. It stops after 120 seconds by default; `--timeout` accepts 1–600 seconds, and Ctrl+C stops it early. It prints only account, conversation and sender IDs, with no message text, media URLs or credentials. It does not download attachments, save messages or dispatch to an Agent. The normal service still requires configured bindings and sender allowlists. Finish the configuration, run `node apps/cli/dist/main.js validate --config relanox.json`, then start the service again.

Connection address: `wss://openws.work.weixin.qq.com`.

## WhatsApp Business {#whatsapp}

User setup: [Connect WhatsApp Business](../channels/whatsapp.md).

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

### Protocol and command details

Relanox uses Graph API `v25.0`; the supported API version is managed by Relanox releases.
