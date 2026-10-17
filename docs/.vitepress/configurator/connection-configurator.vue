<script setup lang="ts">
import { nextTick, useTemplateRef } from 'vue'
import { useConfigurator } from './use-configurator.js'
import ConfiguratorTutorial from './configurator-tutorial.vue'
import PlatformLogo from './platform-logo.vue'
import ChatFields from './chat-fields.vue'
import { accountFields } from './channels.js'

const {
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
} = useConfigurator()

const settingsPane = useTemplateRef<HTMLElement>('settingsPane')
const detailsPanel = useTemplateRef<HTMLDetailsElement>('detailsPanel')

async function showDetails(): Promise<void> {
  detailsOpen.value = true
  await nextTick()
  const pane = settingsPane.value
  const panel = detailsPanel.value
  if (!pane || !panel) {
    return
  }
  if (pane.scrollHeight > pane.clientHeight) {
    pane.scrollTop +=
      panel.getBoundingClientRect().top - pane.getBoundingClientRect().top - 16
  } else {
    panel.scrollIntoView({ block: 'start' })
  }
  panel.querySelector('summary')?.focus({ preventScroll: true })
}
</script>

<template>
  <div class="connection-app">
    <header class="connection-intro">
      <div class="connection-heading">
        <h1>{{ text('Connection configurator', '连接配置器') }}</h1>
        <p>
          {{
            text(
              'Choose your channels and Agents. Your configuration updates as you go.',
              '选择渠道和 Agent，实时查看生成的配置。'
            )
          }}
        </p>
      </div>
      <button class="connection-button" @click="tutorialOpen = true">
        {{ text('Setup guide', '接入教程')
        }}<span class="vpi-arrow-right" aria-hidden="true" />
      </button>
    </header>
    <div class="connection-workspace">
      <section
        class="connection-settings"
        :aria-label="text('Connection settings', '连接设置')"
      >
        <div class="settings-toolbar">
          <h2>{{ text('Connection settings', '连接设置') }}</h2>
        </div>
        <div
          ref="settingsPane"
          class="connection-inputs"
          tabindex="0"
          :aria-label="text('Edit connection settings', '编辑连接设置')"
        >
          <div class="connection-selectors">
            <section class="connection-channels">
              <h2>{{ text('Channels', '渠道') }}</h2>
              <div class="channel-options">
                <label
                  v-for="channel in visibleChannels"
                  :key="channel.channel"
                  class="channel-choice"
                >
                  <input
                    :checked="channel.enabled"
                    type="checkbox"
                    @change="
                      toggleChannel(
                        channel.channel,
                        ($event.target as HTMLInputElement).checked
                      )
                    "
                  />
                  <PlatformLogo :platform="channel.channel" />
                  <span>{{ channelName(channel.channel) }}</span>
                </label>
              </div>
              <button
                class="connection-link more-channels"
                :aria-expanded="more"
                @click="more = !more"
              >
                {{
                  more
                    ? text('Fewer channels', '收起渠道')
                    : text('More channels', '更多渠道')
                }}
                <span
                  :class="more ? 'vpi-chevron-up' : 'vpi-chevron-down'"
                  aria-hidden="true"
                />
              </button>
            </section>
            <section class="connection-agents">
              <h2>Agent</h2>
              <div
                v-for="(agent, index) in state.agents"
                :key="agent.id"
                class="agent-fields"
              >
                <div class="agent-heading">
                  <label :for="`${agent.id}-name`">{{
                    text('Name', '名称')
                  }}</label>
                  <button
                    v-if="state.agents.length > 1"
                    class="connection-link remove-agent"
                    :aria-label="
                      text(`Remove ${agent.name}`, `移除 ${agent.name}`)
                    "
                    @click="deleteAgent(agent.id)"
                  >
                    {{ text('Remove', '移除') }}
                  </button>
                </div>
                <input
                  :id="`${agent.id}-name`"
                  v-model="agent.name"
                  :aria-label="
                    text(`Agent ${index + 1} name`, `Agent ${index + 1} 名称`)
                  "
                  autocomplete="off"
                />
                <label :for="`${agent.id}-type`">{{
                  text('Type', '类型')
                }}</label>
                <div class="agent-type-select platform-select">
                  <PlatformLogo :platform="agent.type" />
                  <select
                    :id="`${agent.id}-type`"
                    v-model="agent.type"
                    :aria-label="
                      text(`Agent ${index + 1} type`, `Agent ${index + 1} 类型`)
                    "
                  >
                    <option value="dot">dot</option>
                    <option value="grok">Grok</option>
                    <option value="muse">Muse</option>
                  </select>
                </div>
                <div class="agent-auth-fields">
                  <label :for="`${agent.id}-token`">{{
                    text('MCP password', 'MCP 密码')
                  }}</label>
                  <input
                    :id="`${agent.id}-token`"
                    v-model="agent.mcpToken"
                    type="text"
                    autocomplete="off"
                    spellcheck="false"
                    :aria-describedby="`${agent.id}-token-hint`"
                  />
                  <button
                    class="connection-link"
                    @click="regenerateToken(agent.id)"
                  >
                    {{ text('Generate new password', '重新生成密码') }}
                  </button>
                  <p :id="`${agent.id}-token-hint`" class="field-hint">
                    {{
                      agent.type === 'dot'
                        ? text(
                            'Select OAuth in dot. Enter this password on the Relanox authorization page.',
                            '在 dot 选择 OAuth，在 Relanox 授权页面输入此密码。'
                          )
                        : text(
                            'Copy the complete address from the setup guide into your Agent. You do not need to enter this password separately.',
                            '将接入教程中的完整地址复制到 Agent，无需另外填写密码。'
                          )
                    }}
                  </p>
                </div>
              </div>
              <button class="connection-link add-agent" @click="appendAgent">
                <span class="vpi-plus" aria-hidden="true" />{{
                  text('Add Agent', '添加 Agent')
                }}
              </button>
            </section>
          </div>

          <section class="connection-mapping">
            <h2>{{ text('Send messages to', '接收消息的 Agent') }}</h2>
            <p v-if="!selected.length" class="connection-muted">
              {{ text('Choose a channel to get started.', '先选择一个渠道。') }}
            </p>
            <template v-for="channel in selected" :key="channel.id">
              <div
                v-for="(chat, index) in channel.chats"
                :key="chat.id"
                class="mapping-row"
              >
                <label
                  :for="`${channel.id}-${chat.id}-target`"
                  class="platform-label"
                >
                  <PlatformLogo :platform="channel.channel" />
                  <span
                    >{{ accountName(channel.id)
                    }}<small>
                      {{
                        chat.chatId ||
                        text(`Chat ${index + 1}`, `聊天 ${index + 1}`)
                      }}{{ chat.threadId ? ` / ${chat.threadId}` : '' }}</small
                    ></span
                  >
                </label>
                <span class="vpi-arrow-right" aria-hidden="true" />
                <select
                  :id="`${channel.id}-${chat.id}-target`"
                  v-model="chat.endpointId"
                  :aria-label="
                    text(
                      `${accountName(channel.id)} chat ${index + 1} Agent`,
                      `${accountName(channel.id)} 聊天 ${index + 1} 接收 Agent`
                    )
                  "
                >
                  <option disabled value="">
                    {{ text('Choose an Agent', '选择 Agent') }}
                  </option>
                  <option
                    v-for="agent in state.agents"
                    :key="agent.id"
                    :value="agent.id"
                  >
                    {{ agent.name || agent.id }}
                  </option>
                </select>
              </div>
            </template>
          </section>

          <details
            ref="detailsPanel"
            class="connection-details"
            :open="detailsOpen"
            @toggle="detailsOpen = ($event.target as HTMLDetailsElement).open"
          >
            <summary>
              {{ text('Connection details', '连接信息')
              }}<span class="connection-muted">{{
                text('Domain, chat and access', '域名、聊天与使用权限')
              }}</span>
            </summary>
            <div class="connection-detail-fields">
              <ul
                v-if="issueMessages.length"
                class="draft-issues"
                aria-live="polite"
              >
                <li v-for="message in issueMessages" :key="message">
                  {{ message }}
                </li>
              </ul>
              <label for="public-host">{{
                text(
                  'Public HTTPS address (required)',
                  '公开 HTTPS 地址（必填）'
                )
              }}</label>
              <input
                id="public-host"
                v-model="state.publicHost"
                placeholder="https://relay.example.com"
                required
                aria-describedby="public-host-hint"
                autocomplete="off"
              />
              <p id="public-host-hint" class="field-hint">
                {{
                  text(
                    'Enter the public address where you deployed Relanox so your Agent can connect.',
                    '填写部署 Relanox 时使用的公开地址，让 Agent 能连接到你的服务。'
                  )
                }}
              </p>
              <template v-if="activeChannel">
                <label for="details-channel">{{
                  text('Account to configure', '配置账号')
                }}</label>
                <div class="platform-select">
                  <PlatformLogo :platform="activeChannel.channel" />
                  <select id="details-channel" v-model="selectedDetails">
                    <option
                      v-for="channel in selected"
                      :key="channel.id"
                      :value="channel.id"
                    >
                      {{ accountName(channel.id) }}
                    </option>
                  </select>
                </div>
                <a
                  class="connection-link field-guide"
                  :href="link(`channels/${activeChannel.channel}.html`)"
                  target="_blank"
                  rel="noopener"
                  >{{
                    text('Where to find these values', '这些信息在哪里找')
                  }}</a
                >
                <div class="account-actions">
                  <button
                    class="connection-link"
                    @click="appendAccount(activeChannel.channel)"
                  >
                    {{ text('Add another account', '添加同渠道账号') }}
                  </button>
                  <button
                    v-if="!activeChannel.id.endsWith('-main')"
                    class="connection-link"
                    @click="deleteAccount(activeChannel.id)"
                  >
                    {{ text('Remove this account', '移除此账号') }}
                  </button>
                </div>
                <p class="field-hint">
                  {{
                    text(
                      'These chats use the same bot account and allowed users. Add another account for a different bot.',
                      '下方聊天共用此机器人账号和允许用户。另一个机器人请添加新账号。'
                    )
                  }}
                </p>
                <ChatFields
                  :channel="activeChannel"
                  :agents="state.agents"
                  :chinese="chinese"
                />
                <label :for="`${activeChannel.channel}-senders`">{{
                  text('Allowed user IDs', '允许使用的用户 ID')
                }}</label>
                <input
                  :id="`${activeChannel.channel}-senders`"
                  v-model="activeChannel.senderIds"
                  :placeholder="
                    definition(activeChannel.channel)?.senderExample
                  "
                />
                <p class="field-hint">
                  {{
                    text(
                      'Separate multiple IDs with commas.',
                      '多个 ID 用英文逗号分隔。'
                    )
                  }}
                </p>
                <div
                  v-for="field in accountFields(activeChannel).filter(
                    (entry) => entry.kind !== 'env'
                  )"
                  :key="field.key"
                  class="extra-field"
                >
                  <label :for="`${activeChannel.channel}-${field.key}`">{{
                    local(field.label)
                  }}</label>
                  <select
                    v-if="field.kind === 'boolean'"
                    :id="`${activeChannel.channel}-${field.key}`"
                    v-model="activeChannel.fields[field.key]"
                  >
                    <option value="true">{{ text('Yes', '是') }}</option>
                    <option value="false">{{ text('No', '否') }}</option>
                  </select>
                  <select
                    v-else-if="field.kind === 'select'"
                    :id="`${activeChannel.channel}-${field.key}`"
                    v-model="activeChannel.fields[field.key]"
                  >
                    <option
                      v-for="option in field.options"
                      :key="option"
                      :value="option"
                    >
                      {{ option }}
                    </option>
                  </select>
                  <input
                    v-else
                    :id="`${activeChannel.channel}-${field.key}`"
                    v-model="activeChannel.fields[field.key]"
                    type="text"
                    :inputmode="field.kind === 'number' ? 'numeric' : 'text'"
                    :placeholder="field.placeholder"
                  />
                </div>
                <details class="account-advanced">
                  <summary>
                    {{ text('Credential variable names', '凭据变量名') }}
                    <span>{{ text('Usually unchanged', '通常无需修改') }}</span>
                  </summary>
                  <div
                    v-for="field in accountFields(activeChannel).filter(
                      (entry) => entry.kind === 'env'
                    )"
                    :key="field.key"
                    class="extra-field"
                  >
                    <label :for="`${activeChannel.id}-${field.key}`">{{
                      local(field.label)
                    }}</label>
                    <input
                      :id="`${activeChannel.id}-${field.key}`"
                      v-model="activeChannel.fields[field.key]"
                      autocomplete="off"
                      spellcheck="false"
                    />
                  </div>
                </details>
              </template>
              <p class="field-hint">
                {{
                  text(
                    'Open the setup guide to see which credentials to copy and where to put them.',
                    '打开接入教程，按步骤复制凭据并完成服务器设置。'
                  )
                }}
              </p>
            </div>
          </details>
        </div>
      </section>

      <section
        class="connection-preview"
        :aria-label="text('Live configuration preview', '实时配置预览')"
      >
        <div class="preview-toolbar">
          <strong>relanox.json</strong
          ><span class="live-label">{{ text('Live', '实时更新') }}</span>
          <div class="preview-actions">
            <button class="connection-button" @click="copy">
              {{ text('Copy', '复制') }}</button
            ><button class="connection-button" @click="download">
              {{ text('Download', '下载') }}
            </button>
          </div>
        </div>
        <div
          class="preview-code"
          tabindex="0"
          :aria-label="text('Generated JSON configuration', '生成的 JSON 配置')"
        >
          <pre><code><span v-for="(line, index) in lines" :key="index" class="code-line"><span class="line-number" aria-hidden="true">{{ index + 1 }}</span><span><span v-for="(token, tokenIndex) in line" :key="tokenIndex" :class="`json-${token.kind}`">{{ token.text }}</span></span></span></code></pre>
        </div>
        <div class="preview-footer">
          <span class="preview-message" role="status">{{
            feedback || text('Changes update automatically.', '配置自动更新')
          }}</span
          ><button
            v-if="issues.length"
            class="draft-label"
            @click="showDetails"
          >
            {{
              text(
                `Draft · ${issues.length} items to complete`,
                `草稿 · ${issues.length} 项待填写`
              )
            }}</button
          ><span v-else>{{
            text('Ready for local validation', '可进行本地校验')
          }}</span>
        </div>
      </section>
    </div>
    <ConfiguratorTutorial
      v-if="tutorialOpen"
      :state="state"
      :variables="variables"
      :connections="connections"
      :issues="issues"
      :chinese="chinese"
      :account-name="accountName"
      @close="tutorialOpen = false"
    />
  </div>
</template>
