# 选择消息渠道

选择你已经在用的聊天软件。每个指南都从账号准备开始，接着说明如何填写配置、连接服务和发送第一条消息。

如果这是首次安装，可以先按照[快速开始](../getting-started.md)中的 Telegram 示例完成一条会话，再替换或添加其他渠道。

| 渠道                                   | 开始前准备                         |
| -------------------------------------- | ---------------------------------- |
| [Telegram](telegram.md)                | Telegram 机器人 token              |
| [Discord](discord.md)                  | Discord 机器人和消息权限           |
| [Slack](slack.md)                      | Slack 应用和工作区授权             |
| [飞书 / Lark](feishu.md)               | 企业自建应用和事件订阅地址         |
| [微信](wechat.md)                      | 扫码配对的 iLink 机器人凭据        |
| [企业微信](wecom.md)                   | 智能机器人 ID；密钥或回调凭据      |
| [钉钉](dingtalk.md)                    | 应用机器人及 Stream 接入凭据       |
| [QQ](qq.md)                            | QQ 机器人 App ID 和密钥            |
| [Microsoft Teams](msteams.md)          | Azure 机器人、Teams 应用和租户信息 |
| [WhatsApp Business Cloud](whatsapp.md) | 企业账号、电话号码和访问 token     |
| [Google Chat](googlechat.md)           | Chat 应用和服务账号                |
| [LINE](line.md)                        | Messaging API 渠道及访问 token     |
| [Matrix](matrix.md)                    | 机器人账号和 homeserver 地址       |
| [Mattermost](mattermost.md)            | 机器人账号和服务器地址             |
| [Signal](signal.md)                    | 已注册账号的 signal-cli 服务       |
| [IRC](irc.md)                          | IRC 服务器和机器人昵称             |

回复默认使用 Markdown。可以让 Agent 使用标题、列表、代码块或带文字的链接，具体显示效果取决于聊天软件。各平台差异见 [Markdown 显示方式](../reference/channels.md#markdown)。

## 连接后做什么

在[配置](../configuration.md)中指定允许使用的用户、聊天或群组，并选择接收消息的 Agent。随后按[连接 Agent](../agents.md)完成 dot、Grok Bot 或 Muse 设置，在指定会话发一条消息确认回复。

需要向其他聊天发送时，先在配置中将该聊天分配给 Agent。部分平台需要先收到该聊天的消息，Agent 才能向它发送。企业微信 HTTP 模式只能回复来信，QQ 和 WhatsApp 还有回复时限。向其他已绑定会话发送前，请查看[目标可用条件](../reference/channels.md#destinations)。

图片和文件按各平台的方式收发。请先读所选渠道的文件说明，再按[收发图片和文件](../media.md)设置需要的下载地址与大小。

需要手写配置或查阅协议参数时，参见[渠道技术参考](../reference/channels.md)。
