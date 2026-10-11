import { computed, onMounted, reactive, ref, watch } from 'vue'
import type { ComputedRef, Ref } from 'vue'
import { useData, withBase } from 'vitepress'
import { CHANNELS } from './channels.js'
import { draftMessage } from './draft-messages.js'
import {
  addAgent,
  addAccount,
  removeAccount,
  buildConfig,
  connectionDetails,
  createState,
  environmentNames,
  generateMcpToken,
  removeAgent,
  validateDraft
} from './model.js'
import type {
  ChannelDefinition,
  ChannelState,
  ConfiguratorState,
  ConnectionDetails,
  Localized
} from './types.js'
import type { DraftIssue } from './model.js'

type ConfiguratorView = {
  text(en: string, zh: string): string
  local(label: Localized): string
  link(path: string): string
  chinese: ComputedRef<boolean>
  state: ConfiguratorState
  more: Ref<boolean>
  detailsOpen: Ref<boolean>
  tutorialOpen: Ref<boolean>
  selectedDetails: Ref<string>
  feedback: Ref<string>
  selected: ComputedRef<ChannelState[]>
  json: ComputedRef<string>
  lines: ComputedRef<{ text: string; kind: string }[][]>
  issues: ComputedRef<DraftIssue[]>
  issueMessages: ComputedRef<string[]>
  variables: ComputedRef<string[]>
  connections: ComputedRef<ConnectionDetails[]>
  activeChannel: ComputedRef<ChannelState | undefined>
  definition(id: string): ChannelDefinition | undefined
  channelName(id: string): string
  accountName(id: string): string
  visibleChannels: ComputedRef<ChannelState[]>
  toggleChannel(id: string, enabled: boolean): void
  appendAccount(channelId: string): void
  deleteAccount(id: string): void
  regenerateToken(id: string): void
  appendAgent(): void
  deleteAgent(id: string): void
  copy(): Promise<void>
  download(): void
}

function tokenKind(text: string): string {
  if (text.startsWith('"')) {
    return text.trimEnd().endsWith(':') ? 'key' : 'string'
  }
  return /^(?:true|false|null|-?\d)/u.test(text) ? 'literal' : 'plain'
}

/** Tokenize JSON as text; never interpret user input as markup. */
export function jsonTokens(line: string): { text: string; kind: string }[] {
  return (
    line.match(
      /"(?:\\.|[^"\\])*"\s*:|"(?:\\.|[^"\\])*"|\b(?:true|false|null)\b|-?\d+(?:\.\d+)?(?:e[+-]?\d+)?|[^"\d-]+|./giu
    ) ?? []
  ).map((text) => ({
    text,
    kind: tokenKind(text)
  }))
}

export function useConfigurator(): ConfiguratorView {
  const { lang } = useData()
  const chinese = computed(() => lang.value === 'zh-CN')
  const text = (en: string, zh: string): string => (chinese.value ? zh : en)
  const local = (label: Localized): string => label[chinese.value ? 'zh' : 'en']

  const link = (path: string): string =>
    withBase(`/${chinese.value ? 'zh-CN' : 'en'}/${path}`)

  const state = reactive(createState())
  onMounted(() => {
    for (const agent of state.agents) {
      agent.mcpToken = generateMcpToken()
    }
  })
  const firstAgent = state.agents[0]
  if (firstAgent) {
    firstAgent.name = text('My assistant', '我的助手')
  }
  const more = ref(false)
  const detailsOpen = ref(false)
  const tutorialOpen = ref(false)
  const selectedDetails = ref('telegram-main')
  const feedback = ref('')

  const selected = computed(() =>
    state.channels.filter((channel) => channel.enabled)
  )

  const config = computed(() => buildConfig(state))
  const json = computed(() => `${JSON.stringify(config.value, null, 2)}\n`)
  const lines = computed(() => json.value.trimEnd().split('\n').map(jsonTokens))
  const issues = computed(() => validateDraft(state))

  const issueMessages = computed(() =>
    issues.value.map((issue) => draftMessage(issue, state, chinese.value))
  )

  const variables = computed(() => environmentNames(config.value))
  const connections = computed(() => connectionDetails(state))

  const activeChannel = computed(
    () =>
      selected.value.find((channel) => channel.id === selectedDetails.value) ??
      selected.value[0]
  )

  const definition = (id: string): ChannelDefinition | undefined =>
    CHANNELS.find((channel) => channel.id === id)

  const channelName = (id: string): string =>
    local(definition(id)?.name ?? { en: id, zh: id })

  function accountName(id: string): string {
    const account = state.channels.find((channel) => channel.id === id)
    if (!account) {
      return ''
    }

    const siblings = state.channels.filter(
      (channel) => channel.channel === account.channel
    )

    const index = siblings.findIndex((channel) => channel.id === id) + 1
    return `${channelName(account.channel)} · ${text(`Account ${index}`, `账号 ${index}`)}`
  }

  const common = ['telegram', 'feishu', 'discord', 'slack', 'wecom', 'dingtalk']

  const visibleChannels = computed(() =>
    [
      ...common,
      ...(more.value
        ? CHANNELS.map((channel) => channel.id).filter(
            (id) => !common.includes(id)
          )
        : [])
    ].flatMap((id) =>
      state.channels.filter((channel) => channel.id === `${id}-main`)
    )
  )

  watch(selected, (channels) => {
    if (!channels.some((channel) => channel.id === selectedDetails.value)) {
      selectedDetails.value = channels[0]?.id ?? ''
    }
  })
  watch(json, () => {
    feedback.value = ''
  })

  function toggleChannel(id: string, enabled: boolean): void {
    for (const channel of state.channels.filter(
      (entry) => entry.channel === id
    )) {
      channel.enabled = enabled
    }
  }

  function appendAccount(channelId: string): void {
    const account = addAccount(state, channelId)
    selectedDetails.value = account.id
  }

  function deleteAccount(id: string): void {
    removeAccount(state, id)
  }

  function appendAgent(): void {
    const agent = addAgent(state)
    agent.mcpToken = generateMcpToken()
    agent.name = text(
      `Assistant ${state.nextAgentNumber - 1}`,
      `助手 ${state.nextAgentNumber - 1}`
    )
  }

  function regenerateToken(id: string): void {
    const agent = state.agents.find((entry) => entry.id === id)
    if (agent) {
      agent.mcpToken = generateMcpToken()
    }
  }

  function deleteAgent(id: string): void {
    removeAgent(state, id)
  }

  async function copy(): Promise<void> {
    try {
      await navigator.clipboard.writeText(json.value)
      feedback.value = text('Configuration copied.', '配置已复制。')
    } catch {
      feedback.value = text(
        'Copy failed. Select and copy the configuration text.',
        '复制失败，请在配置区选择并复制文本。'
      )
    }
  }

  function download(): void {
    const url = URL.createObjectURL(
      new Blob([json.value], { type: 'application/json' })
    )

    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = 'relanox.json'
    document.body.append(anchor)
    anchor.click()
    anchor.remove()
    globalThis.setTimeout(() => {
      URL.revokeObjectURL(url)
    }, 1000)
    feedback.value = text('Configuration downloaded.', '配置已下载。')
  }

  return {
    text,
    local,
    link,
    chinese,
    state,
    more,
    detailsOpen,
    tutorialOpen,
    selectedDetails,
    feedback,
    selected,
    json,
    lines,
    issues,
    issueMessages,
    variables,
    connections,
    activeChannel,
    definition,
    channelName,
    accountName,
    visibleChannels,
    toggleChannel,
    appendAccount,
    deleteAccount,
    regenerateToken,
    appendAgent,
    deleteAgent,
    copy,
    download
  }
}
