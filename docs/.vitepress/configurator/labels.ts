export const fieldLabels: Record<string, [string, string]> = {
  botToken: ['Bot token environment variable', '机器人令牌环境变量'],
  webhookSecret: [
    'Webhook secret environment variable',
    'Webhook 密钥环境变量'
  ],
  signingSecret: ['Signing secret environment variable', '签名密钥环境变量'],
  appId: ['Application ID', '应用 ID'],
  appSecret: ['Application secret environment variable', '应用密钥环境变量'],
  verificationToken: [
    'Verification token environment variable',
    '验证令牌环境变量'
  ],
  encryptKey: ['Encryption key environment variable', '加密密钥环境变量'],
  tenantKey: ['Tenant key', '租户标识'],
  domain: ['Platform domain (feishu or lark)', '平台域（feishu 或 lark）'],
  mode: ['Connection mode', '连接模式'],
  encodingAESKey: [
    'EncodingAESKey environment variable',
    'EncodingAESKey 环境变量'
  ],
  botId: ['Bot ID', '机器人 ID'],
  secret: ['Bot secret environment variable', '机器人密钥环境变量'],
  clientId: ['Client ID', '客户端 ID'],
  clientSecret: ['Client secret environment variable', '客户端密钥环境变量'],
  robotCode: ['Robot code', '机器人代码'],
  environment: ['QQ environment', 'QQ 环境'],
  tenantId: ['Allowed Teams tenant ID', '允许接入的 Teams 租户 ID'],
  tokenUrl: ['Bot application OAuth token URL', '机器人应用 OAuth Token 地址'],
  trustedServiceOrigins: [
    'Trusted service origins (comma separated)',
    '可信服务源（逗号分隔）'
  ],
  phoneNumberId: ['Phone number ID', '电话号码 ID'],
  businessAccountId: ['Business account ID', '企业账户 ID'],
  verifyToken: ['Verification token environment variable', '验证令牌环境变量'],
  accessToken: ['Access token environment variable', '访问令牌环境变量'],
  homeserver: ['Homeserver URL', 'Homeserver 地址'],
  serviceAccount: [
    'Service account JSON environment variable',
    '服务账号 JSON 环境变量'
  ],
  channelSecret: ['Channel secret environment variable', '渠道密钥环境变量'],
  serverUrl: ['Server URL', '服务器地址'],
  token: ['Token environment variable', '令牌环境变量'],
  serviceUrl: ['Signal bridge URL', 'Signal 桥接地址'],
  account: ['Registered account phone number', '已注册账户电话号码'],
  authorization: [
    'Authorization environment variable',
    'Authorization 环境变量'
  ],
  server: ['IRC server hostname', 'IRC 服务器域名'],
  port: ['TLS port', 'TLS 端口'],
  nick: ['Bot nickname', '机器人昵称'],
  'sasl.username': ['SASL account name', 'SASL 账户名'],
  'sasl.password': ['SASL password environment variable', 'SASL 密码环境变量']
}

export const channelSetup: Record<string, [string, string]> = {
  telegram: [
    'Create a bot with BotFather, obtain sender/chat IDs from updates, and register the webhook with its secret token.',
    '通过 BotFather 创建机器人，从 updates 获取发送者和会话 ID，并使用密钥令牌注册 Webhook。'
  ],
  discord: [
    'Invite the bot with message access and enable Message Content Intent. Copy the user and channel IDs from Discord.',
    '邀请机器人并授予消息访问权限，启用 Message Content Intent，从 Discord 复制用户和频道 ID。'
  ],
  slack: [
    'Create a Slack app, grant bot scopes, and configure Events API HTTP delivery. Use workspace user and conversation IDs.',
    '创建 Slack 应用，授予机器人权限并配置 Events API HTTP 投递，填写工作区用户和会话 ID。'
  ],
  feishu: [
    'Create a Feishu/Lark bot app and configure encrypted event subscriptions. Use open IDs for users and chat IDs for conversations.',
    '创建飞书/Lark 机器人应用并配置加密事件订阅，用户使用 open ID，会话使用 chat ID。'
  ],
  wecom: [
    'Create an intelligent robot and obtain its bot ID. Choose WebSocket with a secret, or HTTP callback with Token and EncodingAESKey; use platform sender and chat IDs.',
    '创建智能机器人并获取 bot ID，选择使用密钥的 WebSocket，或使用 Token 和 EncodingAESKey 的 HTTP 回调，填写平台发送者和会话 ID。'
  ],
  dingtalk: [
    'Create a DingTalk app with Stream delivery and obtain the client ID and robot code. Copy the complete sender and conversation IDs from events.',
    '创建使用 Stream 投递的钉钉应用，获取 client ID 和 robot code，从事件复制完整发送者和会话 ID。'
  ],
  qq: [
    'Create a QQ bot app and authorize its WebSocket connection. Use the platform user/member open ID and conversation open ID.',
    '创建 QQ 机器人应用并授权 WebSocket 连接，使用平台用户/成员 open ID 和会话 open ID。'
  ],
  msteams: [
    'Register the bot application, enter its OAuth token URL and allowed Teams tenant separately, then set the messaging endpoint. Copy the trusted service origins and user and conversation IDs from the Teams guide.',
    '注册机器人应用，分别填写应用 OAuth Token 地址与允许接入的 Teams 租户，再设置消息端点。按 Teams 指南填写可信服务源、用户和会话 ID。'
  ],
  whatsapp: [
    'Configure a Meta WhatsApp Business app and subscribe to messages. Set the callback and verification token; use the sender phone number as the direct chat ID.',
    '配置 Meta WhatsApp Business 应用并订阅 messages，设置回调和验证令牌，私聊使用发送者电话号码作为会话 ID。'
  ],
  matrix: [
    'Create a dedicated Matrix user and access token, then join its rooms. Use full user IDs and room IDs.',
    '创建专用 Matrix 用户和访问令牌并加入房间，填写完整用户 ID 和房间 ID。'
  ],
  googlechat: [
    'Configure a Google Chat app with its service account. Set its HTTP endpoint and authentication audience to the generated webhook URL; use users/ and spaces/ resource IDs.',
    '配置 Google Chat 应用及服务账号，将 HTTP 端点和认证受众设为生成的 Webhook 地址，使用 users/ 和 spaces/ 资源 ID。'
  ],
  line: [
    'Create a Messaging API channel and enable webhook delivery. Use source user/group/room IDs; the bot identity is discovered automatically.',
    '创建 Messaging API 渠道并启用 Webhook，使用 source 中的用户/群组/房间 ID，机器人身份会自动查询。'
  ],
  mattermost: [
    'Create a dedicated bot with a token and join its target channel. Use Mattermost user and channel IDs.',
    '创建专用机器人和令牌并加入目标频道，使用 Mattermost 用户和频道 ID。'
  ],
  signal: [
    'Prepare a registered signal-cli daemon account. Use sourceUuid for allowed senders and direct:<sender> or group:<groupId> for chats.',
    '准备已注册的 signal-cli 服务账号，允许发送者使用 sourceUuid，会话使用 direct:<发送者> 或 group:<群组 ID>。'
  ],
  irc: [
    'Connect a dedicated bot over TLS with SASL authentication. Allow senders as account:<name> and bind exact channel names or dm:<folded-nick>.',
    '通过 TLS 和 SASL 认证连接专用机器人，允许发送者使用 account:<名称>，绑定准确频道名或 dm:<规范化昵称>。'
  ]
}
