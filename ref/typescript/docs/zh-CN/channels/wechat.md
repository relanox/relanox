# 微信

将扫码配对的微信 iLink 机器人接入私人会话。Relanox 主动轮询原生 API，此渠道不需要接收 webhook；Agent 仍需通过公开 HTTPS 地址访问 MCP。

## 扫码配对

构建 Relanox 后，在仓库根目录运行：

```sh
node apps/cli/dist/main.js wechat-login --output data/wechat.json
```

用微信扫描终端二维码，在手机上完成确认。命令输出连接状态，将 `botId`、`botToken`、`apiBaseUrl` 和扫码用户的 `userId` 保存到新的 JSON 文件。它不会覆盖现有文件，也不会修改 `relanox.json`。请妥善保护凭据文件，不要提交到仓库。

如果手机要求输入验证码，可以指定验证码文件：

```sh
node apps/cli/dist/main.js wechat-login --output data/wechat.json --verification-code-file data/wechat-code.txt --timeout 300
```

命令运行期间，将手机显示的验证码写入该文件；需要验证时命令会读取它。出现 `wechat_verification_code_rejected` 时，将文件内容改为正确的验证码；命令会等待内容变化后再提交。完成后删除验证码文件。默认等待 180 秒，`--timeout` 接受 1–600 秒。二维码过期后重新运行命令；失败的尝试会移除未完成的输出文件。

## 填写配置器

打开[连接配置器](../connect.md)，选择**微信**。把凭据文件中的 `botId` 填入机器人 ID。接入自己的私人会话时，将返回的 `userId` 同时填入**允许使用的用户 ID**和**聊天 ID**。保留完整原生标识，包括后缀。**话题 / 线程 ID**留空，选择**接收 Agent**。

将返回的 `apiBaseUrl` 复制到配置器的 API 基础地址字段；不同区域的账号可能使用与默认值 `https://ilinkai.weixin.qq.com` 不同的来源地址。下载 `relanox.json`，在启动 Relanox 的环境中，将 `WECHAT_BOT_TOKEN` 设为保存的 `botToken`。登录 JSON 是凭据导出文件，不是服务配置，Relanox 不会自动加载它。

在 PowerShell 中启动时，可以读取 token 而不将其打印出来：

```powershell
$wechat = Get-Content data/wechat.json -Raw | ConvertFrom-Json
$env:WECHAT_BOT_TOKEN = $wechat.botToken
```

按[连接 Agent](../agents.md)设置 Agent 环境变量，验证配置后启动：

```sh
node apps/cli/dist/main.js validate --config relanox.json
node apps/cli/dist/main.js run --config relanox.json
```

手动账号与绑定示例见[技术参考](../reference/channels.md#wechat)。

## 发送第一条消息

从允许的微信用户向配对机器人发送一个简短问题，确认回信出现在同一个私人会话。当前不支持群聊和线程。

发送需要真实来信建立的会话上下文，仅填写用户 ID 不能使目标可用。Relanox 将上下文与轮询游标保存在数据库中，重启后恢复。请同时保留数据库和账号凭据。

## 图片和文件

可以发送图片、语音、视频和文件。Relanox 下载并解密支持的原生媒体，再交给 Agent。微信提供语音转写时会一并传入；媒体引用可下载时也会保留原音频。原始语音编码可能需要可选的[语音识别中间件](../reference/configuration.md#speech-to-text)或 Agent 自身支持。

回复支持文字、图片、视频和文件，不支持发送音频。文字与媒体按阅读顺序作为独立消息发送。Markdown 作为文字发送，具体显示由微信客户端决定。长回复按每段 4,000 个 Unicode 码点拆分。

## 排查问题

出现 `missing_context` 时，在绑定的私人会话中再发一条消息，并核对完整发送者 ID 与允许名单、绑定一致。出现 `wechat_session_expired` 时，重新配对到新的凭据文件，按需更新机器人标识和 token，再重启。收到原生会话过期响应后，轮询会暂停一小时。

附件无法下载时，检查到配置中微信 CDN 的网络连接。暂时的下载故障会保留原游标，以便重试同一条消息。重试状态不确定的回信前先检查投递状态；原生 client ID 不被视为保证去重的机制。

此接入具有本地协议与重启测试，这些检查不代表真实微信账号兼容性已经验证。[腾讯 iLink 协议参考](https://github.com/Tencent/openclaw-weixin/blob/main/docs/protocol.md)说明了原生请求与媒体加密方式。
