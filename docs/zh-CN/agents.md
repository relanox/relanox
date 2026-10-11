# 连接 Agent

在[连接配置器](connect.md)中，把已有的 dot 或 Grok Bot 接到你的聊天。先填写公开 HTTPS 地址，添加 Agent，再为需要回信的聊天选择这个 Agent。

下载配置，打开**你的接入教程**，接入过程中保留这个页面。教程里的地址和密码对应你选择的 Agent；关闭或刷新前，先妥善保存生成的密码。

## 连接 Grok

1. 在配置器中添加 Grok Agent，并为聊天选择它。
2. 在 Grok 中选择负责回信的 Bot，创建使用 webhook 触发的 Routine，复制完整 webhook URL 和 Authorization 值。
3. 打开生成的接入教程，设置其中列出的环境变量。MCP 密码使用教程生成的值，Routine 凭据使用 Grok 提供的值；Authorization 保留完整原值，包括前缀。[快速开始](getting-started.md)介绍环境变量设置和启动方法。
4. 使用下载的配置启动 Relanox，让填写的公网 HTTPS 地址能够访问服务。HTTPS 设置见[部署与日常管理](operations.md)。
5. 将教程中的完整 Grok MCP 地址复制到 Bot 的 MCP 连接设置，选择无需额外认证，并让 Routine 使用这个 Bot。
6. 用允许的发送者在选定聊天发一条短消息，确认回信出现在同一个聊天。

Routine URL、Authorization 和 MCP 地址可能包含凭据，请妥善保存。直接复制教程中的完整 MCP 地址即可。

## 连接 dot

1. 在配置器中添加 dot Agent，并为聊天选择它。
2. 打开生成的接入教程，保存授权密码，把教程列出的环境变量设置为这个值。按[快速开始](getting-started.md)使用下载配置启动 Relanox。
3. 在 ChatGPT 打开 **插件 → 添加 → 添加自定义 MCP 服务器**。填写名称（例如 `Relanox`），将教程中的 dot MCP 地址粘贴到 **服务器 URL**，身份验证保持 **OAuth**。确保该地址可以从公网访问。
4. 阅读提示后选择 **创建为插件**。出现 Relanox 授权页时，输入生成的密码并允许访问。
5. 用允许的发送者在选定聊天发一条短消息，确认回信出现在同一个聊天。

修改授权密码后，重启 Relanox 并重新连接 dot。如果 dot 停止接收新消息，检查插件连接和 Relanox 的消息状态。

## 检查连接

无需给 Bot 或 Routine 另写回信 prompt。更新 Relanox 后，刷新或重新连接 Agent 的 MCP 连接，再发一条消息确认回信。

没有回信时，先检查聊天是否选对 Agent、发送者是否在允许名单中，再按生成教程核对连接地址和密码。Grok 还需核对 Routine URL 和完整 Authorization；dot 则检查插件连接与授权。通过[消息状态与恢复](reference/core.md)查看消息停在哪一步。

手动 JSON 配置、认证细节和 MCP 工具约定见 [Agent 配置与协议](reference/agents.md)。附件使用见[收发图片和文件](media.md)。
