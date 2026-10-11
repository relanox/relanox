import { CHANNELS } from './channels.js'
import type { DraftIssue } from './model.js'
import type { ConfiguratorState, Localized } from './types.js'

const messages: Record<string, Localized> = {
  placeholderHost: {
    en: 'Replace the example domain with your own.',
    zh: '将示例域名替换为你自己的域名。'
  },
  publicHost: {
    en: 'Enter an HTTPS address or a local HTTP address (127.0.0.1 or [::1]), without a path.',
    zh: '填写 HTTPS 地址或本机 HTTP 地址（127.0.0.1 或 [::1]），不包含路径。'
  },
  publicHostRequired: {
    en: 'The selected webhook channels require a public HTTPS address.',
    zh: '所选回调渠道需要填写公开 HTTPS 地址。'
  },
  channelRequired: {
    en: 'Choose at least one channel.',
    zh: '至少选择一个渠道。'
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
  const channel = CHANNELS.find((entry) => entry.id === channelId)

  const field = channel?.fields.find(
    (entry) => entry.key === fieldPath.join('.')
  )

  const subject = [agent?.name, channel?.name[locale], field?.label[locale]]
    .filter(Boolean)
    .join(' · ')

  const message =
    messages[issue.code]?.[locale] ??
    (chinese ? '检查此项。' : 'Check this value.')

  return subject ? `${subject}: ${message}` : message
}
