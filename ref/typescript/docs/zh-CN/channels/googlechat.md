# Google Chat

通过 Google Chat HTTP 应用，在空间和消息串中使用 Agent。

## 准备账号

在 Google Cloud 项目启用 Chat API，配置 Chat 应用并创建其服务账号。将完整服务账号 JSON 保存到 `GOOGLE_CHAT_SERVICE_ACCOUNT_JSON`。使用 `chat.bot` 权限的应用认证。按照组织策略开放应用，并将它加入目标空间。

## 在配置器中填写

打开[连接配置器](../connect.md)，选择 **Google Chat**，填写上一步取得的账号信息。凭据变量名保持默认，按照下载后生成的教程设置实际密钥。将下文取得的发送者 ID 填入「允许使用的用户 ID」，会话 ID 填入「聊天 ID」，有话题时填写「话题 / 线程 ID」，并选择「接收 Agent」。多个允许用户用英文逗号分隔。

将下载的配置保存为 `relanox.json`，并按接入教程在服务器上设置密钥。完成下方的平台连接设置后启动或重启服务，并按「发送第一条消息」验证。手写配置与协议参数见[技术参考](../reference/channels.md#googlechat)。

请机器人管理员准备下面列出的用户和会话 ID，再填写配置。管理员可以从已有的机器人消息记录中核对这些值。使用平台分配的 ID，而非聊天中显示的名称。

从消息事件取得发送者资源名（`users/<id>`）填入 「允许使用的用户 ID」、空间名（`spaces/<id>`）填入 「聊天 ID」、消息串名（`spaces/<id>/threads/<id>`）填入指定的 「话题 / 线程 ID」。复制完整资源名。收到的消息含消息串时，其完整名称必须与 「话题 / 线程 ID」一致。需要使用其他消息串时，分别添加对应绑定。

## 启用连接

在配置器中将公网地址填为 `https://relay.example.com`。在 Google Chat 控制台将应用 HTTP 端点设为 `https://relay.example.com/channels/googlechat-main/webhook`，认证 audience 模式选择 **HTTP endpoint URL**。如果修改了账号名，请同步替换端点路径中的 `googlechat-main`。发送应用交互前启动 Relanox。

Relanox 使用 Google 官方 Chat REST SDK 和认证库处理服务账号令牌获取、缓存和刷新、调用方验签及附件下载。验签采用 SDK 的证书缓存和五分钟令牌时钟容差。Core 调度消息重试，SDK 传输层重试已关闭。已经交给 SDK 的发送可能在取消期间完成，包括共享认证正在刷新时；Relanox 会记录实际取得的回执。入站附件保留空间归属检查、拒绝重定向，并在读取下载流时执行 Core 媒体预算，未声明大小的响应也受限。

## 发送第一条消息

在配置的空间/消息串中 @ 已安装应用并发送“你好”。私聊也需先按其消息事件中的实际空间和消息串字段完成绑定。打开同一消息串查看回答。

Agent 指定 `reply.requestId` 时，Google Chat 会在绑定的会话或消息串中引用该条来信，媒体卡片同样适用。原事件需包含原生 `lastUpdateTime` 或 `createTime`；时间戳缺失时会拒绝该次引用发送。原消息后来被编辑时，Google 也会拒绝旧版本的引用。不传 `reply` 则不显示引用。

## 图片和文件

提问时可直接上传附件到 Chat。接收生成媒体需按[媒体](../media.md)配置 公网地址。图片回复显示为卡片，音频、视频和文件显示为带名称的下载按钮。公网媒体地址需让收件者访问，并供 Google 获取图片。

Core 执行媒体预算，默认 100 MiB。Google 判断支持的图片格式和平台限制，适配层不再单独预判上传大小或图片格式。原生卡片的排版限制仍适用。

## 常见问题

认证错误时，检查控制台是否选择 HTTP endpoint URL audience 模式，并核对端点为 公网地址 加 `/channels/<账号 ID>/webhook`。发送失败时，检查服务账号 JSON、Chat API 和应用是否在空间内。图片或下载不可用时，检查公网媒体地址。需要 Agent 读取文件内容时，将文件直接上传到 Chat。
