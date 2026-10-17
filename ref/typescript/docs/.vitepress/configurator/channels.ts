import { channelData } from './channel-data.js'
import type {
  ChannelDefinition,
  ChannelState,
  FieldDefinition,
  Json
} from './types.js'
import { fieldLabels, channelSetup } from './labels.js'

const names: Record<string, [string, string]> = {
  telegram: ['Telegram', 'Telegram'],
  discord: ['Discord', 'Discord'],
  slack: ['Slack', 'Slack'],
  feishu: ['Feishu / Lark', '飞书 / Lark'],
  wecom: ['WeCom', '企业微信'],
  wechat: ['WeChat', '微信'],
  dingtalk: ['DingTalk', '钉钉'],
  qq: ['QQ', 'QQ'],
  msteams: ['Microsoft Teams', 'Microsoft Teams'],
  whatsapp: ['WhatsApp', 'WhatsApp'],
  matrix: ['Matrix', 'Matrix'],
  googlechat: ['Google Chat', 'Google Chat'],
  line: ['LINE', 'LINE'],
  mattermost: ['Mattermost', 'Mattermost'],
  signal: ['Signal', 'Signal'],
  irc: ['IRC', 'IRC']
}

const userFields = new Set([
  'appId',
  'tenantKey',
  'botId',
  'clientId',
  'robotCode',
  'tenantId',
  'tokenUrl',
  'phoneNumberId',
  'businessAccountId',
  'homeserver',
  'serverUrl',
  'serviceUrl',
  'account',
  'server',
  'nick',
  'sasl.username'
])

const choices: Record<string, string[]> = {
  domain: ['feishu', 'lark'],
  environment: ['production', 'sandbox'],
  mode: ['websocket', 'webhook']
}

function personalizeField(field: FieldDefinition): FieldDefinition {
  if (userFields.has(field.key)) {
    field.placeholder = field.defaultValue
    field.defaultValue = ''
    field.requiresInput = true
  }
  const options = choices[field.key]
  if (options) {
    field.kind = 'select'
    field.options = options
  }
  return field
}

function fieldsFor(
  config: Record<string, Json>,
  prefix = ''
): FieldDefinition[] {
  return Object.entries(config).flatMap(([key, value]) => {
    const path = prefix + key
    const translated = fieldLabels[path]
    const label = { en: translated?.[0] ?? path, zh: translated?.[1] ?? path }
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      if (typeof value.env === 'string') {
        return [
          { key: path, label, kind: 'env' as const, defaultValue: value.env }
        ]
      }
      return fieldsFor(value, `${path}.`)
    }
    if (Array.isArray(value)) {
      return [
        {
          key: path,
          label,
          kind: 'list' as const,
          defaultValue: value
            .filter((item): item is string => typeof item === 'string')
            .join(', ')
        }
      ]
    }
    let kind: FieldDefinition['kind'] = 'text'
    if (typeof value === 'number') {
      kind = 'number'
    }
    if (typeof value === 'boolean') {
      kind = 'boolean'
    }
    return [{ key: path, label, kind, defaultValue: String(value) }]
  })
}

export const CHANNELS: ChannelDefinition[] = channelData.map((entry) => {
  const name = names[entry.id] ?? [entry.id, entry.id]
  return {
    id: entry.id,
    name: { en: name[0] ?? entry.id, zh: name[1] ?? entry.id },
    fields: fieldsFor(entry.defaults as unknown as Record<string, Json>).map(
      personalizeField
    ),
    chatExample: entry.chatExample,
    senderExample: entry.senderExample,
    webhook: entry.webhook,
    setup: {
      en: channelSetup[entry.id]?.[0] ?? '',
      zh: channelSetup[entry.id]?.[1] ?? ''
    }
  }
})

/** Fields relevant to the selected platform connection mode. */
export function accountFields(channel: ChannelState): FieldDefinition[] {
  const fields =
    CHANNELS.find((entry) => entry.id === channel.channel)?.fields ?? []

  if (channel.channel !== 'wecom') {
    return fields
  }

  const excluded =
    channel.fields.mode === 'webhook' ? ['secret'] : ['token', 'encodingAESKey']

  return fields.filter((field) => !excluded.includes(field.key))
}

export function accountUsesWebhook(channel: ChannelState): boolean {
  if (channel.channel === 'wecom') {
    return channel.fields.mode === 'webhook'
  }
  return CHANNELS.some((entry) => entry.id === channel.channel && entry.webhook)
}
