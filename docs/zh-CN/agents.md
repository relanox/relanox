# 连接 Agent

在[连接配置器](connect.md)中，把已有的 dot 或 Grok Bot 接到你的聊天。先填写公开 HTTPS 地址，添加 Agent，再为需要回信的聊天选择这个 Agent。

下载配置，打开**你的接入教程**，接入过程中保留这个页面。教程里的地址和密码对应你选择的 Agent；关闭或刷新前，先妥善保存生成的密码。

## 连接 Grok

使用 Grok Bot 桌面客户端，并登录你的付费 Cursor 账号。Cursor Pro 包含 Grok Bot 用量；普通 Grok 聊天网页不是这里的配置入口。

1. 在 Relanox 配置器中添加 Grok Agent，并为聊天选择它。
2. 在负责回信的 Grok Bot 对话中发送：“创建一个仅由 webhook 触发的例行任务，处理收到的用户消息，使用 Relanox MCP 连接提供的说明完成回复。不要添加定时计划。”
3. 点击 Bot 名称，在 **详情 → 例行任务** 中打开该任务。**Webhook** 区域包含 **POST 到、密钥、标头**。Routine URL 使用“POST 到”的值；Routine Authorization 环境变量填写 `Bearer <密钥>`。如果复制的是“标头”，去掉开头的 `Authorization:` 字段名。
4. 打开生成的接入教程，保存 MCP 密码、设置列出的环境变量，并让 Relanox 在公开 HTTPS 地址运行。启动步骤见[快速开始](getting-started.md)。
5. 在同一 Cursor 账号的控制台打开 **Plugins & MCPs → Add → Custom MCP**。填写名称，类型保持 **URL**，把教程生成的完整 Grok MCP 地址粘贴到 **Server URL**。**HTTP headers、Client ID、Client Secret** 留空，点击 **Add MCP**。
6. 回到 Grok Bot，打开 **连接应用 → 你的插件**，确认连接已就绪，并能看到 `relanox_send_message`、`relanox_read_media` 和 `relanox_create_upload`。插件连接由账号共享，例行任务使用前面选定的 Bot。
7. 用允许的发送者在绑定聊天发一条短消息，确认回信出现在原聊天，而不只是 Grok Bot 对话里。

这里没有统一的“MCP 回调”字段：Relanox 调用例行任务的 webhook 唤醒 Bot，Bot 再通过 MCP 连接把回复交回 Relanox。请妥善保存 Routine URL、密钥和完整 MCP 地址。

## 连接 dot

1. 在配置器中添加 dot Agent，并为聊天选择它。
2. 打开生成的接入教程，保存授权密码，把教程列出的环境变量设置为这个值。按[快速开始](getting-started.md)使用下载配置启动 Relanox。
3. 在 ChatGPT 打开 **插件 → 添加 → 添加自定义 MCP 服务器**。填写名称（例如 `Relanox`），将教程中的 dot MCP 地址粘贴到 **服务器 URL**，身份验证保持 **OAuth**。确保该地址可以从公网访问。
4. 阅读提示后选择 **创建为插件**。出现 Relanox 授权页时，输入生成的密码并允许访问。
5. 在 dot 对话中启用 Relanox 插件，然后发送：“订阅 Relanox 的来信。每次收到事件时读取其中的消息，使用 Relanox 工具回复原聊天。”允许 dot 创建订阅。
6. 用允许的发送者在选定聊天发一条短消息，确认回信出现在同一个聊天。OAuth 登录成功或通知被接收，并不代表 dot 已经回信。

修改授权密码后，重启 Relanox 并重新连接 dot。如果 dot 停止接收新消息，检查插件连接和 Relanox 的消息状态。

## 检查连接

无需给 Bot 或 Routine 另写回信 prompt。更新 Relanox 后，刷新或重新连接 Agent 的 MCP 连接，再发一条消息确认回信。

没有回信时，先检查聊天是否选对 Agent、发送者是否在允许名单中，再按生成教程核对连接地址和密码。Grok 还需核对 Routine URL 和完整 Authorization；dot 则检查插件连接与授权。通过[消息状态与恢复](reference/core.md)查看消息停在哪一步。

手动 JSON 配置、认证细节和 MCP 工具约定见 [Agent 配置与协议](reference/agents.md)。附件使用见[收发图片和文件](media.md)。
