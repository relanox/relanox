<script setup lang="ts">
import { useConfigurator } from './use-configurator.js'
import ConfiguratorTutorial from './configurator-tutorial.vue'

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
  visibleChannels,
  appendAgent,
  deleteAgent,
  copy,
  download
} = useConfigurator()
</script>

<template>
  <div class="connection-app">
    <header class="connection-intro">
      <h1>{{ text('Connection configurator', '连接配置器') }}</h1>
      <p>
        {{
          text(
            'Choose your channels and Agents. Your configuration updates as you go.',
            '选择渠道和 Agent，实时查看生成的配置。'
          )
        }}
      </p>
    </header>
    <div class="connection-workspace">
      <section
        class="connection-inputs"
        :aria-label="text('Connection settings', '连接设置')"
      >
        <div class="connection-selectors">
          <section class="connection-channels">
            <h2>{{ text('Channels', '渠道') }}</h2>
            <label
              v-for="channel in visibleChannels"
              :key="channel.channel"
              class="channel-choice"
            >
              <input v-model="channel.enabled" type="checkbox" />
              <span>{{ channelName(channel.channel) }}</span>
            </label>
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
            <label :for="`${channel.channel}-target`">{{
              channelName(channel.channel)
            }}</label>
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
              text('Public HTTPS hostname', '公开 HTTPS 域名')
            }}</label>
            <input
              id="public-host"
              v-model="state.publicHost"
              placeholder="relay.example.com"
              autocomplete="off"
            />
            <p class="field-hint">
              {{
                text(
                  'Use the domain pointing to your Relanox server.',
                  '填写指向你的 Relanox 服务的域名。'
                )
              }}
            </p>
            <template v-for="agent in state.agents" :key="agent.id">
              <template v-if="agent.type === 'dot'">
                <label :for="`${agent.id}-callback`"
                  >{{ agent.name }} ·
                  {{ text('dot callback origin', 'dot 回调来源') }}</label
                >
                <input
                  :id="`${agent.id}-callback`"
                  v-model="agent.callbackOrigin"
                  type="url"
                  placeholder="https://your-dot-callback.example.com"
                />
                <p class="field-hint">
                  {{
                    text(
                      'Copy the origin (protocol and hostname) from your dot Events callback address.',
                      '使用 dot Events 回调地址的来源部分，即协议和主机名。'
                    )
                  }}
                </p>
              </template>
            </template>
            <template v-if="activeChannel">
              <label for="details-channel">{{
                text('Channel to configure', '配置渠道')
              }}</label>
              <select id="details-channel" v-model="selectedDetails">
                <option
                  v-for="channel in selected"
                  :key="channel.channel"
                  :value="channel.channel"
                >
                  {{ channelName(channel.channel) }}
                </option>
              </select>
              <a
                class="connection-link field-guide"
                :href="link(`channels/${activeChannel.channel}.html`)"
                target="_blank"
                rel="noopener"
                >{{ text('Where to find these values', '这些信息在哪里找') }}</a
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
                :placeholder="definition(activeChannel.channel)?.senderExample"
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
                  'Credentials use environment variables. Set their values on your server; this page needs no secrets.',
                  '凭据使用环境变量，在服务器上设置其值即可，这里无需填写密钥。'
                )
              }}
            </p>
          </div>
        </details>
        <button
          class="connection-button tutorial-button"
          @click="tutorialOpen = true"
        >
          {{ text('View setup guide', '查看接入教程')
          }}<span class="vpi-arrow-right" aria-hidden="true" />
        </button>
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
          <span>{{
            text(
              'Updates as you change your selections.',
              '修改选择后，配置自动更新。'
            )
          }}</span
          ><button
            v-if="issues.length"
            class="draft-label"
            @click="detailsOpen = true"
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
          <p v-if="feedback" role="status">{{ feedback }}</p>
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
