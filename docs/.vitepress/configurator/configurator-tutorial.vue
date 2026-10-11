<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { withBase } from 'vitepress'
import { CHANNELS } from './channels.js'
import { webhookDetails } from './model.js'
import type { ChannelDefinition, ConfiguratorState } from './types.js'
import type { DraftIssue } from './model.js'

const props = defineProps<{
  state: ConfiguratorState
  variables: string[]
  connections: { id: string; mcpUrl: string; tokenEnv: string }[]
  issues: DraftIssue[]
  chinese: boolean
}>()

const emit = defineEmits<{ close: [] }>()
const dialog = ref<HTMLDialogElement>()
const text = (en: string, zh: string): string => (props.chinese ? zh : en)

const link = (path: string): string =>
  withBase(`/${props.chinese ? 'zh-CN' : 'en'}/${path}`)

const channels = computed(() =>
  props.state.channels.filter((channel) => channel.enabled)
)

const webhooks = computed(() => webhookDetails(props.state))

const channelDefinition = (id: string): ChannelDefinition | undefined =>
  CHANNELS.find((channel) => channel.id === id)

const channelName = (id: string): string =>
  channelDefinition(id)?.name[props.chinese ? 'zh' : 'en'] ?? id

const agentName = (id: string): string =>
  props.state.agents.find((agent) => agent.id === id)?.name ?? id

const previousFocus =
  typeof document === 'undefined' ? null : document.activeElement

onMounted(() => dialog.value?.showModal())
onUnmounted(() => {
  if (previousFocus instanceof HTMLElement) {
    previousFocus.focus()
  }
})
</script>

<template>
  <dialog
    ref="dialog"
    class="connection-tutorial"
    aria-labelledby="tutorial-title"
    @close="emit('close')"
  >
    <header>
      <h2 id="tutorial-title">
        {{ text('Your setup guide', '你的接入教程') }}
      </h2>
      <button class="connection-button" autofocus @click="dialog?.close()">
        {{ text('Close', '关闭') }}
      </button>
    </header>
    <div class="tutorial-body">
      <p v-if="issues.length" class="tutorial-notice">
        {{
          text(
            'This configuration is a draft. Complete the connection details before running it.',
            '当前配置仍是草稿。请先补全连接信息，再启动服务。'
          )
        }}
      </p>
      <p v-if="!channels.length">
        {{
          text(
            'Select a channel to generate its setup steps.',
            '选择渠道后，这里会展示对应的接入步骤。'
          )
        }}
      </p>
      <ol class="tutorial-steps">
        <li>
          <h3>{{ text('Prepare your chat accounts', '准备渠道账号') }}</h3>
          <p v-for="channel in channels" :key="channel.channel">
            <a
              :href="link(`channels/${channel.channel}.html`)"
              target="_blank"
              rel="noopener"
              >{{ channelName(channel.channel) }}</a
            >
            ·
            {{ channel.chatId || text('Chat ID not filled', '聊天 ID 待填写') }}
            <span class="vpi-arrow-right" aria-hidden="true" />
            {{ agentName(channel.endpointId) }}<br /><span>{{
              channelDefinition(channel.channel)?.setup[
                props.chinese ? 'zh' : 'en'
              ]
            }}</span>
          </p>
        </li>
        <li>
          <h3>
            {{
              text(
                'Install Relanox and save your configuration',
                '安装 Relanox 并保存配置'
              )
            }}
          </h3>
          <p>
            {{
              text(
                'Follow the installation steps, then download the live configuration and save it as relanox.json in the project directory.',
                '按照安装步骤准备 Relanox，将右侧配置下载为 relanox.json，放在项目目录中。'
              )
            }}
            <a
              :href="link('getting-started.html')"
              target="_blank"
              rel="noopener"
              >{{ text('Installation guide', '安装步骤') }}</a
            >
          </p>
          <p>
            {{
              text(
                'This configuration uses SQLite. Keep data/relanox.sqlite on persistent storage. Point your HTTPS domain to the service on 127.0.0.1:8787.',
                '这份配置使用 SQLite，请持久保存 data/relanox.sqlite。将公开 HTTPS 域名转发到本机 127.0.0.1:8787。'
              )
            }}
            <a :href="link('operations.html')" target="_blank" rel="noopener">{{
              text('Deployment guide', '部署说明')
            }}</a>
          </p>
        </li>
        <li>
          <h3>
            {{ text('Set these environment variables', '设置这些环境变量') }}
          </h3>
          <p>
            {{
              text(
                'Supply the actual values in your server or shell environment before starting. Use independent random MCP tokens for each Agent; Routine values come from Grok.',
                '启动前，在服务器或终端环境中设置实际值。每个 Agent 的 MCP token 使用独立随机值，Routine 凭据从 Grok 获取。'
              )
            }}
          </p>
          <ul class="environment-list">
            <li v-for="variable in variables" :key="variable">
              <code>{{ variable }}</code>
            </li>
          </ul>
          <p>
            {{
              text(
                'The CLI does not automatically load a .env file. See the installation guide for PowerShell and the deployment guide for Docker.',
                'CLI 不会自动读取 .env 文件。PowerShell 设置方法见安装步骤，Docker 设置方法见部署说明。'
              )
            }}
          </p>
        </li>
        <li>
          <h3>{{ text('Validate and start', '校验并启动') }}</h3>
          <pre><code>node apps/cli/dist/main.js validate --config relanox.json
node apps/cli/dist/main.js run --config relanox.json</code></pre>
          <p>
            {{
              text(
                'Keep the process running. After changing configuration or environment variables, restart it.',
                '保持进程运行。修改配置或环境变量后，需要重启服务。'
              )
            }}
          </p>
        </li>
        <li>
          <h3>{{ text('Connect your Agents', '连接你的 Agent') }}</h3>
          <div
            v-for="connection in connections"
            :key="connection.id"
            class="tutorial-agent"
          >
            <strong>{{ agentName(connection.id) }}</strong>
            <p>{{ text('MCP address', 'MCP 地址') }}</p>
            <code class="connection-url">{{ connection.mcpUrl }}</code>
            <p>
              {{ text('Bearer token: the value of', 'Bearer token：使用变量') }}
              <code>{{ connection.tokenEnv }}</code> {{ text('', '的值。') }}
            </p>
            <p>
              {{
                state.agents.find((agent) => agent.id === connection.id)
                  ?.type === 'dot'
                  ? text(
                      'Enable the relanox.message_available Events subscription and automatic renewal in dot.',
                      '在 dot 开启 relanox.message_available Events 订阅与自动续订。'
                    )
                  : text(
                      'Configure a webhook-triggered Routine in Grok, using the same Routine URL and Authorization values as the environment variables.',
                      '在 Grok 设置 webhook 触发的 Routine，确保 URL 和 Authorization 与环境变量一致。'
                    )
              }}
            </p>
          </div>
          <p>
            <a :href="link('agents.html')" target="_blank" rel="noopener">{{
              text(
                'Copy the fixed reply instructions into each Agent',
                '将固定回信指令复制到每个 Agent'
              )
            }}</a>
          </p>
        </li>
        <li>
          <h3>
            {{
              text(
                'Connect the channels and send a message',
                '连接渠道并发送消息'
              )
            }}
          </h3>
          <p>
            {{
              text(
                'Finish webhook registration or platform connection as described in each selected channel guide. From an allowed account, send a message in the configured chat and confirm a reply arrives.',
                '按所选渠道的指南完成 webhook 注册或平台连接。用允许使用的账号在已配置聊天中发一条消息，确认收到回信。'
              )
            }}
          </p>
          <pre><code>node apps/cli/dist/main.js doctor --config relanox.json --management-url http://127.0.0.1:8788
node apps/cli/dist/main.js status --config relanox.json</code></pre>
          <p v-for="webhook in webhooks" :key="webhook.id">
            {{ channelName(webhook.id.replace(/-main$/u, '')) }} ·
            {{ text('Platform callback address', '平台回调地址') }}
            <code class="connection-url">{{ webhook.webhookUrl }}</code>
          </p>
          <p>
            <a
              :href="link('reference/core.html')"
              target="_blank"
              rel="noopener"
              >{{ text('Check a delayed reply', '没有收到回信时如何排查') }}</a
            >
          </p>
        </li>
      </ol>
    </div>
  </dialog>
</template>
