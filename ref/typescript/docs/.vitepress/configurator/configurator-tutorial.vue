<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { withBase } from 'vitepress'
import { CHANNELS } from './channels.js'
import { webhookDetails } from './model.js'
import type {
  ChannelDefinition,
  ConfiguratorState,
  ConnectionDetails
} from './types.js'
import type { DraftIssue } from './model.js'

const props = defineProps<{
  state: ConfiguratorState
  variables: string[]
  connections: ConnectionDetails[]
  issues: DraftIssue[]
  chinese: boolean
  accountName(id: string): string
}>()

const clipboardStatus = ref('')

async function copyToken(token: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(token)
    clipboardStatus.value = text('Password copied.', '密码已复制。')
  } catch {
    clipboardStatus.value = text(
      'Copy failed. Select and copy the password.',
      '复制失败，请选择并复制密码。'
    )
  }
}

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

const agentName = (id: string): string =>
  props.state.agents.find((agent) => agent.id === id)?.name ?? id

const isMuse = (id: string): boolean =>
  props.state.agents.some((agent) => agent.id === id && agent.type === 'muse')

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
      <p v-if="clipboardStatus" role="status">{{ clipboardStatus }}</p>
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
          <p v-for="channel in channels" :key="channel.id">
            <a
              :href="link(`channels/${channel.channel}.html`)"
              target="_blank"
              rel="noopener"
              >{{ accountName(channel.id) }}</a
            >
            <br />
            <span
              v-for="(chat, index) in channel.chats"
              :key="chat.id"
              class="tutorial-chat"
            >
              {{
                chat.chatId ||
                text(
                  `Chat ${index + 1} not filled`,
                  `聊天 ${index + 1} ID 待填写`
                )
              }}{{ chat.threadId ? ` / ${chat.threadId}` : '' }}
              <span class="vpi-arrow-right" aria-hidden="true" />
              {{ agentName(chat.endpointId) }}
            </span>
            <span>{{
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
                'Follow the deployment guide to make your service available at the address you entered and keep its data backed up.',
                '按部署说明，让服务可通过你填写的公开地址访问，并定期备份数据。'
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
                'Supply the actual values in your server or shell environment before starting. Use the generated MCP passwords shown below; Routine values come from Grok.',
                '启动前，在服务器或终端环境中设置实际值。MCP 密码使用下方生成的值，Routine 凭据从 Grok 获取。'
              )
            }}
          </p>
          <p v-if="state.agents.some((agent) => agent.type === 'grok')">
            {{
              text(
                'Create the Grok Routine before setting its variables. In the Bot chat, ask for a webhook-only routine that processes incoming messages using the Relanox MCP instructions, without a schedule. Click the Bot name, then open Details → Routines. Copy POST to as the Routine URL and use Bearer followed by a space and the key as Authorization. Remove the Authorization: label if you copy the header.',
                '设置 Routine 变量前，先在 Grok Bot 对话中让它创建仅由 webhook 触发、按 Relanox MCP 说明处理来信的例行任务，不添加定时计划。点击 Bot 名称，打开“详情 → 例行任务”。Routine URL 使用“POST 到”，Authorization 使用 Bearer 加空格再加密钥。如果复制标头，去掉 Authorization: 字段名。'
              )
            }}
          </p>
          <p v-if="state.agents.some((agent) => agent.type === 'muse')">
            {{
              text(
                'Pair a device with Muse first. Set each Muse CREDENTIALS_DIRECTORY variable to its persistent pairing directory, using a separate pairing for each running service. See the Agent guide for device setup.',
                '先在 Muse 中配对设备，将各 Muse 的 CREDENTIALS_DIRECTORY 变量设置为持久化配对目录。每个运行中的服务使用独立配对，设备配置方法见 Agent 指南。'
              )
            }}
            <a :href="link('agents.html#connect-muse')">{{
              text('Muse setup', 'Muse 配置')
            }}</a>
          </p>
          <div
            v-for="connection in connections"
            :key="connection.id"
            class="tutorial-agent"
          >
            <code>{{ connection.tokenEnv }}</code>
            <code class="connection-url">{{ connection.token }}</code>
            <button
              class="connection-button"
              @click="copyToken(connection.token)"
            >
              {{ text('Copy password', '复制密码') }}
            </button>
          </div>
          <p>
            {{
              text(
                'Save these passwords before closing or reloading the page; they are not included in the downloaded file.',
                '关闭或刷新页面前请保存这些密码；下载的配置文件不包含密码。'
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
            <code class="connection-url">{{
              connection.mcpUrl ||
              text(
                'Enter your public HTTPS address first.',
                '请先填写公开 HTTPS 地址。'
              )
            }}</code>
            <p v-if="isMuse(connection.id)">
              {{
                text(
                  'Add this complete URL as a custom MCP connection in Muse. The URL contains the connection password; leave additional authentication fields empty.',
                  '在 Muse 添加自定义 MCP 连接，使用此完整地址。地址已包含连接密码，其他身份验证字段留空。'
                )
              }}
            </p>
            <p v-else>
              {{
                connection.auth === 'oauth'
                  ? text(
                      'In ChatGPT, open Plugins → Add → Add custom MCP server. Enter a name, paste this address into Server URL, and keep OAuth selected.',
                      '在 ChatGPT 打开“插件 → 添加 → 添加自定义 MCP 服务器”，填写名称，将此地址粘贴到“服务器 URL”，身份验证保持 OAuth。'
                    )
                  : text(
                      'In the Cursor dashboard, open Plugins & MCPs → Add → Custom MCP. Enter a name and this complete Server URL; leave HTTP headers and OAuth fields empty.',
                      '在 Cursor 控制台打开 Plugins & MCPs → Add → Custom MCP，填写名称和此完整 Server URL，HTTP headers 和 OAuth 字段留空。'
                    )
              }}
            </p>
            <p v-if="isMuse(connection.id)">
              {{
                text(
                  'Enable the connection in the same Muse whose paired device credentials you configured. Ask Muse to follow the Relanox MCP instructions and reply to every incoming notification through its original channel.',
                  '在配对凭据对应的 Muse 中启用连接，请 Muse 遵循 Relanox MCP 说明，将每条来信回复到原渠道。'
                )
              }}
            </p>
            <p v-else>
              {{
                state.agents.find((agent) => agent.id === connection.id)
                  ?.type === 'dot'
                  ? text(
                      'Review the notice and choose Create as plugin. On the Relanox authorization page, enter the generated password and allow access. Then enable the plugin in dot and ask it to subscribe to incoming Relanox messages and reply to each event’s original chat.',
                      '阅读提示后选择“创建为插件”。在 Relanox 授权页输入生成的密码并允许访问。然后在 dot 中启用插件，请它订阅 Relanox 来信，并回复每个事件对应的原聊天。'
                    )
                  : text(
                      'In Grok Bot, open Connect apps → Your plugins and confirm the MCP connection is ready. Use the Bot whose Routine URL you set above.',
                      '在 Grok Bot 打开“连接应用 → 你的插件”，确认 MCP 连接已就绪。使用上面设置 Routine URL 时选定的 Bot。'
                    )
              }}
            </p>
          </div>
          <p>
            {{
              text(
                'Once connected, your Agent can reply with text and attachments. No separate reply prompt is needed.',
                '连接后即可收发文字与附件，无需另外编写回信说明。'
              )
            }}
            <a :href="link('agents.html')" target="_blank" rel="noopener">{{
              text('Agent connection details', 'Agent 连接说明')
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
            {{ accountName(webhook.id) }} ·
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
