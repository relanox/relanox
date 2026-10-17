import { CHANNELS } from './channels.js'
import type { DraftIssue } from './model.js'
import type { ConfiguratorState, Localized } from './types.js'

const messages: Record<string, Localized> = {
  placeholderHost: {
    en: 'Replace the example domain with your own.',
    zh: '将示例域名替换为你自己的域名。'
  },
  publicHost: {
    en: 'Enter your public HTTPS address without a path.',
    zh: '填写公开 HTTPS 地址，不包含路径。'
  },
  agentPublicHost: {
    en: 'dot, Grok and Muse need a public HTTPS address to reach Relanox. Enter your deployed service address.',
    zh: 'dot、Grok 和 Muse 需要公开 HTTPS 地址来访问 Relanox，请填写部署后的服务地址。'
  },
  duplicateChat: {
    en: 'This chat and thread are already bound. Edit the existing binding or choose another chat.',
    zh: '此聊天与线程已有绑定，请修改已有绑定或填写其他聊天。'
  },
  channelRequired: {
    en: 'Choose at least one channel.',
    zh: '至少选择一个渠道。'
  },
  mcpToken: {
    en: 'Use at least 32 letters, digits, underscores or hyphens for the MCP password.',
    zh: 'MCP 密码至少包含 32 个字母、数字、下划线或连字符。'
  },
  agentRequired: { en: 'Add an Agent.', zh: '添加一个 Agent。' },
  agentName: { en: 'Enter a name.', zh: '填写名称。' },
  chatId: { en: 'Enter the chat ID.', zh: '填写聊天 ID。' },
  senderIds: {
    en: 'Enter the IDs of the users who may use this connection.',
    zh: '填写允许使用的用户 ID。'
  },
  mapping: {
    en: 'Choose the Agent that should receive messages.',
    zh: '选择接收消息的 Agent。'
  },
  fieldRequired: { en: 'Fill in your actual value.', zh: '填写你的实际值。' },
  environmentName: {
    en: 'Use a valid environment variable name.',
    zh: '填写有效的环境变量名称。'
  },
  number: {
    en: 'Enter a valid nonnegative integer.',
    zh: '填写有效的非负整数。'
  },
  fieldValue: {
    en: 'Use a supported value from the channel guide.',
    zh: '请使用渠道指南中支持的值。'
  },
  url: {
    en: 'Enter a valid secure service URL.',
    zh: '填写有效的安全服务地址。'
  },
  origin: {
    en: 'Enter HTTPS origins without paths, separated by commas.',
    zh: '填写不含路径的 HTTPS 来源，多个来源用逗号分隔。'
  }
}

export function draftMessage(
  issue: DraftIssue,
  state: ConfiguratorState,
  chinese: boolean
): string {
  const locale = chinese ? 'zh' : 'en'
  const agent = state.agents.find((entry) => entry.id === issue.target)
  const [channelId, ...fieldPath] = issue.target.split('.')
  const account = state.channels.find((entry) => entry.id === channelId)
  const channel = CHANNELS.find((entry) => entry.id === account?.channel)

  const chatIndex =
    account?.chats.findIndex((chat) => chat.id === fieldPath[0]) ?? -1

  const field = channel?.fields.find(
    (entry) => entry.key === fieldPath.join('.')
  )

  const subject = [
    agent?.name,
    channel?.name[locale],
    account
      ? `${chinese ? '账号' : 'Account'} ${state.channels.filter((entry) => entry.channel === account.channel).findIndex((entry) => entry.id === account.id) + 1}`
      : '',
    chatIndex >= 0 ? `${chinese ? '聊天' : 'Chat'} ${chatIndex + 1}` : '',
    field?.label[locale]
  ]
    .filter(Boolean)
    .join(' · ')

  const message =
    messages[issue.code]?.[locale] ??
    (chinese ? '检查此项。' : 'Check this value.')

  return subject ? `${subject}: ${message}` : message
}
