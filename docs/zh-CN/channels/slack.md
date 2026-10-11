# Slack

通过 Slack 应用，在频道、私聊和消息串中使用 Agent。

## 准备账号

创建并安装工作区应用，将机器人 Token 和签名密钥分别保存到 `SLACK_BOT_TOKEN`、`SLACK_SIGNING_SECRET`。记录应用 ID；授予 `chat:write`、所用会话对应的消息历史权限；文件需要 `files:read` 和 `files:write`。将应用邀请到所选频道。

## 在配置器中填写

打开[连接配置器](../configuration.md)，选择 **Slack**，填写上一步取得的账号信息与密钥环境变量名。将下文取得的发送者 ID 填入「允许使用的用户 ID」，会话 ID 填入「聊天 ID」，有话题时填写「话题 / 线程 ID」，并选择「接收 Agent」。多个允许用户用英文逗号分隔。

| 配置器字段         | 填写内容                       |
| ------------------ | ------------------------------ |
| 机器人令牌环境变量 | 变量名：`SLACK_BOT_TOKEN`      |
| 签名密钥环境变量   | 变量名：`SLACK_SIGNING_SECRET` |
| 应用 ID            | 替换示例：`A123ABC`            |

下载配置后，在启动服务的环境中设置密钥变量，保存为 `relanox.json`。完成下方的平台连接设置后启动或重启服务，并按「发送第一条消息」验证。手写配置与协议参数见[技术参考](../reference/channels.md#slack)。

打开成员资料并复制成员 ID，填入 「允许使用的用户 ID」。打开频道详情复制频道 ID，填入 「聊天 ID」；私聊会话 ID 可通过应用的会话信息 API 取得。将所选消息串根消息的 `ts` 填入 「话题 / 线程 ID」；该消息串的回复中它表现为 `thread_ts`。先创建一条根消息并复制消息链接。链接若以 `p1710000000000001` 结尾，根消息时间戳就是 `1710000000.000001`（在最后六位前加小数点）。把该时间戳填入 「话题 / 线程 ID」，保存配置并重启 Relanox，再在该消息串中回复。每条接收的 Slack 消息都有消息串 ID，每个消息串需要对应的精确绑定。

## 启用连接

HTTP 接收方式：将事件请求地址设为 `https://relay.example.com/channels/slack-main/events`，按需订阅 `message.channels`、`message.groups`、`message.im`、`message.mpim` 或 `app_mention`。Slack 验证地址前先启动 Relanox。也可启用 Socket Mode，填写 App Token 环境变量名，清空签名密钥，并为 App Token 授予 `connections:write`；此时 Relanox 自动建立连接。HTTP 接收与 Socket Mode 选择一种，仅填写相应凭据。

## 发送第一条消息

在配置的消息串中回复“你好”，或根据订阅的事件 @ 应用。回复出现在消息串中，请打开消息串查看。

## 图片和文件

发送问题时可分享图片、音频、视频或文件。生成文件会发回同一频道或消息串。确认已安装的机器人 Token 具备两个文件权限；修改权限后重新安装应用。

## 常见问题

地址验证失败时，检查公网事件地址和签名密钥。频道消息缺失时，检查事件订阅和应用是否在频道内。Socket Mode 连接失败时，核对 App Token 和 `connections:write`，更新环境变量后重启 Relanox。
