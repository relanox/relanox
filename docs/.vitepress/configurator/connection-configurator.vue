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
              'Start with one bot account and an existing hosted Agent. This page creates a configuration draft.',
              '从一个机器人账号和已有的云端 Agent 开始。本页生成配置草稿。'
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
          <p class="connection-onboarding">
            {{ text('First time? Prepare your', '首次使用？先准备好') }}
            <a :href="link('channels.html')">{{ text('channel credentials', '通道凭据') }}</a>
            {{ text('and', '和') }}
            <a :href="link('agents.html')">{{ text('Agent account', 'Agent 账号') }}</a>{{ text('.', '。') }}
            {{ text('Then fill in the public HTTPS address, allowed user IDs and exact conversation ID below. Credential fields take variable names or file paths, never secret values.', '然后填写下方的公网 HTTPS 地址、允许用户 ID 和准确的会话 ID。凭据字段填写变量名或文件路径，不填写实际密钥。') }}
          </p>
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
                  <label :for="`${agent.id}-endpoint`">{{
                    text('Endpoint ID', '端点 ID')
                  }}</label>
                  <input
                    :id="`${agent.id}-endpoint`"
                    v-model="agent.endpointId"
                  />
                  <label :for="`${agent.id}-token`">{{
                    text(
                      'MCP token environment variable',
                      'MCP token 环境变量名'
                    )
                  }}</label>
                  <input
                    :id="`${agent.id}-token`"
                    v-model="agent.mcpToken"
                    autocomplete="off"
                  />
                  <label :for="`${agent.id}-token-file`">{{
                    text('MCP token file (optional)', 'MCP token 文件（可选）')
                  }}</label>
                  <input
                    :id="`${agent.id}-token-file`"
                    v-model="agent.fields['mcp.token.file']"
                  />
                  <template v-if="agent.type !== 'dot'">
                    <label :for="`${agent.id}-auth`">{{
                      text('MCP authentication', 'MCP 认证方式')
                    }}</label>
                    <select
                      :id="`${agent.id}-auth`"
                      v-model="agent.fields['mcp.auth']"
                    >
                      <option value="bearer">Bearer</option>
                      <option value="path">Path</option>
                    </select>
                  </template>
                  <template v-if="agent.type === 'grok'">
                    <template
                      v-for="key in ['routineUrl', 'routineAuthorization']"
                      :key="key"
                    >
                      <label :for="`${agent.id}-${key}`"
                        >{{ key }} ·
                        {{ text('environment variable', '环境变量名') }}</label
                      >
                      <input
                        :id="`${agent.id}-${key}`"
                        v-model="agent.fields[key]"
                      />
                      <label :for="`${agent.id}-${key}-file`"
                        >{{ key }} ·
                        {{ text('file (optional)', '文件（可选）') }}</label
                      >
                      <input
                        :id="`${agent.id}-${key}-file`"
                        v-model="agent.fields[`${key}.file`]"
                      />
                    </template>
                  </template>
                  <template v-if="agent.type === 'muse'">
                    <template
                      v-for="key in [
                        'credentialsDirectory',
                        'vmId',
                        'sessionId'
                      ]"
                      :key="key"
                    >
                      <label :for="`${agent.id}-${key}`"
                        >{{ key
                        }}{{
                          key === 'credentialsDirectory'
                            ? ''
                            : text(' (optional)', '（可选）')
                        }}</label
                      >
                      <input
                        :id="`${agent.id}-${key}`"
                        v-model="agent.fields[key]"
                        :placeholder="
                          key === 'credentialsDirectory' ? 'paired/muse' : ''
                        "
                      />
                    </template>
                  </template>
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
              <label for="storage-driver">{{
                text('Database', '数据库')
              }}</label>
              <select id="storage-driver" v-model="state.storageDriver">
                <option value="sqlite">SQLite</option>
                <option value="postgres">PostgreSQL</option>
              </select>
              <template v-if="state.storageDriver === 'sqlite'"
                ><label for="storage-path">{{
                  text('SQLite path', 'SQLite 路径')
                }}</label
                ><input id="storage-path" v-model="state.storagePath"
              /></template>
              <template v-else
                ><label for="storage-url">{{
                  text(
                    'Database URL environment variable',
                    '数据库 URL 环境变量名'
                  )
                }}</label
                ><input id="storage-url" v-model="state.storageUrl" /><label
                  for="storage-url-file"
                  >{{
                    text(
                      'Database URL file (optional)',
                      '数据库 URL 文件（可选）'
                    )
                  }}</label
                ><input
                  id="storage-url-file"
                  v-model="state.storageUrlFile" /><label
                  for="storage-schema"
                  >{{ text('Schema (optional)', 'Schema（可选）') }}</label
                ><input id="storage-schema" v-model="state.storageSchema"
              /></template>
              <label for="http-listen">{{
                text('HTTP listen', 'HTTP 监听地址')
              }}</label
              ><input id="http-listen" v-model="state.listen" />
              <label for="management-listen">{{
                text('Management listen', '管理监听地址')
              }}</label
              ><input id="management-listen" v-model="state.managementListen" />
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
                  :href="link(`channels.html#${activeChannel.channel}`)"
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
                <label :for="`${activeChannel.id}-account-id`">{{
                  text('Account ID', '账号 ID')
                }}</label>
                <input
                  :id="`${activeChannel.id}-account-id`"
                  v-model="activeChannel.accountId"
                />
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
                    <label :for="`${activeChannel.id}-${field.key}-file`">{{
                      text(
                        'Secret file (optional; environment variable takes precedence)',
                        '凭据文件（可选；环境变量优先）'
                      )
                    }}</label>
                    <input
                      :id="`${activeChannel.id}-${field.key}-file`"
                      v-model="activeChannel.fields[`${field.key}.file`]"
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
              {{ issues.length ? text('Download draft', '下载草稿') : text('Download', '下载') }}
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
            feedback || text('Open setup guide after export.', '导出后打开接入教程。')
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
