# 连接 Agent

在[连接配置器](connect.md)中，把已有的 dot、Grok Bot 或 Muse 接到你的聊天。先填写公开 HTTPS 地址，添加 Agent，再为需要回信的聊天选择这个 Agent。

下载配置，打开**你的接入教程**，接入过程中保留这个页面。教程里的地址和密码对应你选择的 Agent；关闭或刷新前，先妥善保存生成的密码。

## 连接 Grok

使用 Grok Bot 桌面客户端，并登录你的付费 Cursor 账号。Cursor Pro 包含 Grok Bot 用量；普通 Grok 聊天网页不是这里的配置入口。

1. 在 Relanox 配置器中添加 Grok Agent，并为聊天选择它。
2. 在负责回信的 Grok Bot 对话中发送：“创建一个仅由 webhook 触发的例行任务，处理收到的用户消息，使用 Relanox MCP 连接提供的说明完成回复。不要添加定时计划。”
3. 点击 Bot 名称，在 **详情 → 例行任务** 中打开该任务。**Webhook** 区域包含 **POST 到、密钥、标头**。Routine URL 使用“POST 到”的值；Routine Authorization 环境变量填写 `Bearer <密钥>`。如果复制的是“标头”，去掉开头的 `Authorization:` 字段名。
4. 打开生成的接入教程，保存 MCP 密码、设置列出的环境变量，并让 Relanox 在公开 HTTPS 地址运行。启动步骤见[快速开始](getting-started.md)。
5. 在同一 Cursor 账号的控制台打开 **Plugins & MCPs → Add → Custom MCP**。填写名称，类型保持 **URL**，把教程生成的完整 Grok MCP 地址粘贴到 **Server URL**。**HTTP headers、Client ID、Client Secret** 留空，点击 **Add MCP**。
6. 回到 Grok Bot，打开 **连接应用 → 你的插件**，确认连接已就绪。插件连接由账号共享，例行任务使用前面选定的 Bot。
7. 用允许的发送者在绑定聊天发一条短消息，确认回信出现在原聊天，而不只是 Grok Bot 对话里。

Grok 需要同时完成例行任务设置和 MCP 连接。请妥善保存 Routine URL、密钥和完整 MCP 地址。

## 连接 dot

1. 在配置器中添加 dot Agent，并为聊天选择它。
2. 打开生成的接入教程，保存授权密码，把教程列出的环境变量设置为这个值。按[快速开始](getting-started.md)使用下载配置启动 Relanox。
3. 在 ChatGPT 打开 **插件 → 添加 → 添加自定义 MCP 服务器**。填写名称（例如 `Relanox`），将教程中的 dot MCP 地址粘贴到 **服务器 URL**，身份验证保持 **OAuth**。确保该地址可以从公网访问。
4. 阅读提示后选择 **创建为插件**。出现 Relanox 授权页时，输入生成的密码并允许访问。
5. 在 dot 对话中启用 Relanox 插件，然后发送：“订阅 Relanox 的来信。每次收到事件时读取其中的消息，使用 Relanox 工具回复原聊天。”允许 dot 创建订阅。
6. 用允许的发送者在选定聊天发一条短消息，确认回信出现在同一个聊天。OAuth 登录成功或通知被接收，并不代表 dot 已经回信。

请 dot 检查 Relanox 连接，列出可用聊天，并确认已订阅来信。修改授权密码后，重启 Relanox 并重新连接 dot。如果 dot 停止接收新消息，检查插件连接和 Relanox 的消息状态。

从未记录端点归属的旧版本升级后，请让 dot 刷新或重新创建 `relanox.message_available` 订阅。在此之前，Relanox 会报告没有有效订阅，并重试待通知的来信。修改端点配置也需要重新订阅；只更换同名环境变量的密码值则不需要。

## 连接 Muse {#connect-muse}

Muse 在自己的云端虚拟机中运行。Relanox 通过已配对的 Muse 设备连接发送来信通知；Muse 通过 Relanox MCP 连接器读取附件，并回复原聊天。

1. 获取个人 [Muse Gadget SDK token](https://gadgets.muse.ai/settings/sdk-tokens)，按[官方 Linux 设备配对指南](https://github.com/facebookincubator/muse-gadget-sdk/tree/main/linux)完成配对。在手机应用中开启 **Settings → Devices → Developer mode**，添加配对过程显示的设备。
2. Relanox 使用该设备凭据前，停止并禁用 SDK daemon。systemd 安装可运行 `sudo systemctl disable --now musegadget`。Relanox 不需要 daemon 提供的本机命令服务。
3. 将这次配对的 `identity.json`、`pairing.json` 和 `sdk_token` 复制到由 Relanox 服务用户持有的私有持久目录。服务需要能更新 `pairing.json`，以保存轮换后的 token。各个独立运行的 Relanox 部署使用各自的配对和目录；不要让 SDK daemon 或其他客户端同时使用同一份凭据。
4. 在配置器中添加 Muse Agent，并为聊天选择它。将生成的凭据目录环境变量（通常为 `RELANOX_AGENT_1_CREDENTIALS_DIRECTORY`）设为该目录的绝对路径。保存并设置独立生成的 MCP token。容器部署需要可写挂载该目录，变量使用容器内路径。
5. 让 Relanox 在公开 HTTPS 地址运行。在 Muse 中请它使用生成的完整 Muse MCP URL 创建自定义连接器，并确认能够调用 `relanox_status`。[Muse 连接器指南](https://muse.ai/platform/docs)说明了平台的连接器机制。
6. 用允许的用户在绑定聊天发一条短消息，确认回信出现在原聊天。通知出现在 Muse 对话中，并不表示已经向原会话发送回复。

适配器发送文字通知，包含来源 channel、请求 ID 和附件元数据。Muse 通过 MCP 工具读取和发送媒体；不支持通过原生聊天接口上传语音或附件，也不会自动转发 Muse 自己的聊天回答。默认使用账号的默认 VM 和主聊天；手动配置可选择 `vmId` 和 `sessionId`，见 [Muse 配置参考](reference/agents.md#connect-muse)。

除 Relanox 数据库外，还应单独备份凭据目录。本地 SDK 边界与 MCP 测试覆盖此适配器，尚未通过真实 Muse 账号验证往返消息。

## 检查连接

无需给 Bot 或例行任务另写回复说明。

三种 Agent 都可以先查询 Relanox 中可用的聊天，再按平台权限和发送条件向已授权聊天发送，即使 Relanox 尚未收到该聊天的消息。部分平台需要近期来信或已建立的会话，见[目标可用条件](reference/channels.md#destinations)。消息入队表示已保存等待发送；要求重发前，先检查投递结果。

没有回信时，先检查聊天是否选对 Agent、发送者是否在允许名单中，再按生成教程核对连接地址和密码。Grok 还需核对 Routine URL 和完整 Authorization；dot 则检查插件连接与授权。Muse 需要检查配对凭据目录、该目录是否被独占使用，以及自定义连接器。通过[消息状态与恢复](reference/core.md)查看消息停在哪一步。

升级后，如果 Agent 无法发送消息，先刷新或重新连接 MCP。若无效，使用新名称创建连接；Grok 还需在例行任务中选择新连接，再发送一条测试消息。

手动 JSON 配置、认证细节和 MCP 工具约定见 [Agent 配置与协议](reference/agents.md)。附件使用见[收发图片和文件](media.md)。
