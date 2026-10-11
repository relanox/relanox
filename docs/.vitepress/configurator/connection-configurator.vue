<script setup lang="ts">
import { nextTick, useTemplateRef } from 'vue'
import { useConfigurator } from './use-configurator.js'
import ConfiguratorTutorial from './configurator-tutorial.vue'
import PlatformLogo from './platform-logo.vue'

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
  httpsChannels,
  hasOAuth,
  lines,
  issues,
  issueMessages,
  variables,
  connections,
  activeChannel,
  definition,
  channelName,
  visibleChannels,
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
                  <input v-model="channel.enabled" type="checkbox" />
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
                            'The MCP address includes this password. Paste the full address into Grok.',
                            'MCP 地址包含此密码，将完整地址粘贴到 Grok。'
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
            <h2>{{ text('Send messages to', '渠道映射') }}</h2>
            <p v-if="!selected.length" class="connection-muted">
              {{ text('Choose a channel to get started.', '先选择一个渠道。') }}
            </p>
            <div
              v-for="channel in selected"
              :key="channel.channel"
              class="mapping-row"
            >
              <label :for="`${channel.channel}-target`" class="platform-label">
                <PlatformLogo :platform="channel.channel" />
                <span>{{ channelName(channel.channel) }}</span>
              </label>
              <span class="vpi-arrow-right" aria-hidden="true" />
              <select
                :id="`${channel.channel}-target`"
                v-model="channel.endpointId"
                :aria-label="
                  text(
                    `${channelName(channel.channel)} Agent`,
                    `${channelName(channel.channel)} 接收 Agent`
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
                httpsChannels.length || hasOAuth
                  ? text(
                      'Public HTTPS address (required)',
                      '公开 HTTPS 地址（必填）'
                    )
                  : text('Service address (optional)', '服务地址（可选）')
              }}</label>
              <input
                id="public-host"
                v-model="state.publicHost"
                :placeholder="
                  httpsChannels.length || hasOAuth
                    ? 'https://relay.example.com'
                    : 'http://127.0.0.1:8787'
                "
                :required="httpsChannels.length > 0 || hasOAuth"
                aria-describedby="public-host-hint"
                autocomplete="off"
              />
              <p id="public-host-hint" class="field-hint">
                {{
                  hasOAuth
                    ? text(
                        'dot OAuth needs a public HTTPS address pointing to your Relanox server.',
                        'dot OAuth 需要指向 Relanox 服务的公开 HTTPS 地址。'
                      )
                    : httpsChannels.length
                      ? text(
                          `${httpsChannels.join(', ')} needs HTTPS webhook delivery. Enter the address pointing to your Relanox server.`,
                          `${httpsChannels.join('、')} 需要 HTTPS 回调地址，请填写指向 Relanox 服务的地址。`
                        )
                      : text(
                          'These channels connect outward and do not need an HTTPS callback. Leave blank for http://127.0.0.1:8787; your Agent must still be able to reach the MCP address.',
                          '所选渠道主动连接平台，无需 HTTPS 回调。留空使用 http://127.0.0.1:8787；Agent 仍需能够访问 MCP 地址。'
                        )
                }}
              </p>
              <template v-if="activeChannel">
                <label for="details-channel">{{
                  text('Channel to configure', '配置渠道')
                }}</label>
                <div class="platform-select">
                  <PlatformLogo :platform="activeChannel.channel" />
                  <select id="details-channel" v-model="selectedDetails">
                    <option
                      v-for="channel in selected"
                      :key="channel.channel"
                      :value="channel.channel"
                    >
                      {{ channelName(channel.channel) }}
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
                <label :for="`${activeChannel.channel}-chat`">{{
                  text('Chat ID', '聊天 ID')
                }}</label>
                <input
                  :id="`${activeChannel.channel}-chat`"
                  v-model="activeChannel.chatId"
                  :placeholder="definition(activeChannel.channel)?.chatExample"
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
                <label :for="`${activeChannel.channel}-thread`">{{
                  text('Thread ID (optional)', '话题 / 线程 ID（可选）')
                }}</label>
                <input
                  :id="`${activeChannel.channel}-thread`"
                  v-model="activeChannel.threadId"
                  :placeholder="
                    text(
                      'Only for a specific thread',
                      '仅绑定特定话题或线程时填写'
                    )
                  "
                />
                <div
                  v-for="field in definition(
                    activeChannel.channel
                  )?.fields.filter((entry) => entry.kind !== 'env')"
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
              </template>
              <p class="field-hint">
                {{
                  text(
                    'Channel credentials use environment variables. Set their values on your server. Copy the generated MCP passwords from the setup guide.',
                    '渠道凭据使用环境变量，请在服务器上设置其值。生成的 MCP 密码可从接入教程复制。'
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
      @close="tutorialOpen = false"
    />
  </div>
</template>
