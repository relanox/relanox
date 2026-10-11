# Mattermost

在你的 Mattermost 服务器，通过专用机器人使用频道和消息串。

## 准备账号

创建机器人账号和 Access Token，将 Token 保存到 `MATTERMOST_TOKEN`；把机器人加入目标频道并授予读取和发帖权限。附件还需 `upload_file` 和 `read_channel` 权限。

## 在配置器中填写

打开[连接配置器](../connect.md)，选择 **Mattermost**，填写上一步取得的账号信息。凭据变量名保持默认，按照下载后生成的教程设置实际密钥。将下文取得的发送者 ID 填入「允许使用的用户 ID」，会话 ID 填入「聊天 ID」，有话题时填写「话题 / 线程 ID」，并选择「接收 Agent」。多个允许用户用英文逗号分隔。

| 配置器字段 | 填写内容               |
| ---------- | ---------------------- |
| 服务器地址 | 上一步取得的服务器地址 |

下载配置后，在启动服务的环境中设置密钥变量，保存为 `relanox.json`。完成下方的平台连接设置后启动或重启服务，并按「发送第一条消息」验证。手写配置与协议参数见[技术参考](../reference/channels.md#mattermost)。

「允许使用的用户 ID」填 Mattermost 用户 ID，「聊天 ID」填频道 ID。机器人 Token 可调用 `GET /api/v4/users/username/<username>` 取得发送者 ID，`GET /api/v4/teams/name/<team>/channels/name/<channel>` 取得频道 ID；消息事件也包含 `user_id` 和 `channel_id`。指定消息串时，「话题 / 线程 ID」填根帖 ID。

## 启用连接

`serverUrl` 填 Mattermost 服务器的 HTTPS 基础地址。启动 Relanox 后会自动打开服务器 WebSocket 连接。确保反向代理允许 WebSocket，并保持进程运行。

## 发送第一条消息

用允许的用户在绑定频道发送“你好”。消息串绑定需在根帖下回复。机器人将回答发到同一频道或消息串。

## 图片和文件

像平常一样附加图片、音频、视频或文件。生成文件以原生帖子附件发回，Mattermost 会生成可用预览。文件需符合服务器上传大小设置和 Relanox 媒体限制。

## 常见问题

连接失败时，核对 HTTPS 服务器地址、Token 和代理 WebSocket 设置。帖子缺失时，检查频道成员资格与 ID。Relanox 断线期间发送的问题，在恢复连接后重新发送。上传失败时，检查机器人权限和服务器文件大小设置。
