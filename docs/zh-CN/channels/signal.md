# Signal 与 signal-cli

通过独立维护的 signal-cli 服务，使用专用 Signal 账号。

## 准备账号

安装 signal-cli，注册或关联 Signal 账号，并启动其 HTTP JSON-RPC/SSE 服务。记录账号号码。备份 Relanox 数据库时一并备份 signal-cli 账号/会话数据。远程访问使用带认证的 HTTPS 代理，将完整 Authorization 请求头值保存到 `SIGNAL_BRIDGE_AUTHORIZATION`。

## 在配置器中填写

打开[连接配置器](../connect.md)，选择 **Signal**，填写上一步取得的账号信息。凭据变量名保持默认，按照下载后生成的教程设置实际密钥。将下文取得的发送者 ID 填入「允许使用的用户 ID」，会话 ID 填入「聊天 ID」，有话题时填写「话题 / 线程 ID」，并选择「接收 Agent」。多个允许用户用英文逗号分隔。

| 配置器字段         | 填写内容                       |
| ------------------ | ------------------------------ |
| Signal 桥接地址    | 上一步取得的Signal 桥接地址    |
| 已注册账户电话号码 | 上一步取得的已注册账户电话号码 |

将下载的配置保存为 `relanox.json`，并按接入教程在服务器上设置密钥。完成下方的平台连接设置后启动或重启服务，并按「发送第一条消息」验证。手写配置与协议参数见[技术参考](../reference/channels.md#signal)。

要取得发送者 ID，先发送一条测试消息，让服务管理员查看 `/api/v1/events?account=<account>` 事件流。允许发送者优先使用收到信封的 `sourceUuid`；没有 UUID 时使用号码/source 标识。私聊绑定填写 `direct:<sender>`，群聊填写 `group:<groupId>`。群组 ID 可从服务的群组信息或收到的信封取得。

## 启用连接

「Signal 桥接地址」填服务或代理基础地址，「已注册账户电话号码」填账号号码。Relanox 启动时自动连接。

## 发送第一条消息

用允许的 Signal 联系人，向专用账号或其已加入的绑定群组发送“你好”。保持 signal-cli 和 Relanox 同时运行，以接收问题。

## 图片和文件

正常发送图片、音频、视频或文件。确保 signal-cli 下载接收附件，以便 Relanox 获取。生成附件通过同一专用 Signal 账号发出，并需符合 Signal 与 Relanox 媒体限制。

## 常见问题

消息缺失时，检查服务的注册账号、事件流和代理认证。附件失败时，确认 signal-cli 已下载并保留附件。服务重启或长时间断线后，重新发送仍未得到回答的问题。
