<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { withBase } from 'vitepress'
import { webhookDetails } from './model.js'
import type { ConfiguratorState, ConnectionDetails } from './types.js'
import type { DraftIssue } from './model.js'
const props = defineProps<{
  state: ConfiguratorState
  variables: string[]
  connections: ConnectionDetails[]
  issues: DraftIssue[]
  chinese: boolean
  accountName(id: string): string
}>()
const text = (en: string, zh: string): string => (props.chinese ? zh : en)
const emit = defineEmits<{ close: [] }>()
const dialog = ref<HTMLDialogElement>()
onMounted(() => dialog.value?.showModal())
const callbacks = computed(() => webhookDetails(props.state))
</script>
<template>
  <dialog
    ref="dialog"
    class="connection-tutorial"
    aria-labelledby="setup-guide-title"
    @close="emit('close')"
  >
    <header>
      <h2 id="setup-guide-title">{{ text('Setup guide', '接入教程') }}</h2>
      <button class="connection-link" @click="dialog?.close()">
        {{ text('Close', '关闭') }}
      </button>
    </header>
    <div class="tutorial-body tutorial-steps">
      <h2>{{ text('Save and validate the configuration', '保存并校验配置') }}</h2>
      <p>
        {{
          text(
            'Download relanox.json. If you already have a configuration, back it up and merge this draft into it. Keep the existing account IDs, endpoint IDs and credential variable names or file paths.',
            '下载 relanox.json。如果已有配置，请先备份，再合并这份草稿。保留原有的账号 ID、端点 ID，以及凭据的变量名或文件路径。'
          )
        }}
      </p>
      <p>
        {{
          text(
            'Set the credentials on your server using the environment variables or files named in the configuration. If both are configured, the environment variable takes precedence. The downloaded file contains these references, not the secret values.',
            '在服务器上设置配置中指定的环境变量或凭据文件。两者都配置时，优先使用环境变量。下载的配置只包含变量名和文件路径，不包含实际密钥。'
          )
        }}
      </p>
      <ul>
        <li v-for="variable in variables" :key="variable">
          <code>{{ variable }}</code>
        </li>
      </ul>
      <template v-if="state.channels.some((channel) => channel.enabled && channel.channel === 'wechat')">
        <p>{{ text('Complete QR pairing for the selected WeChat account:', '为所选微信账号完成扫码配对：') }}</p>
        <pre><code>relanox wechat-login --account ACCOUNT_ID --config relanox.json</code></pre>
      </template>
      <p>
        {{
          text(
            'Validate the downloaded draft, then run the server:',
            '校验下载的草稿，然后启动服务：'
          )
        }}
      </p>
      <pre><code>relanox validate --config relanox.json --json
relanox run --config relanox.json</code></pre>
      <p v-if="issues.length">
        {{
          text(
            'Fill in the fields listed under Connection details, then run relanox validate. The page checks only basic fields; the command checks the full configuration.',
            '补齐“连接信息”中列出的字段，再运行 relanox validate。页面只检查基础字段，命令会检查完整配置。'
          )
        }}
      </p>
      <p>
        {{
          text(
            'Use an HTTPS reverse proxy for the HTTP listener and keep the management listener private. Set the callback URLs below in each platform. Accounts that use sockets or polling do not need a callback.',
            '通过 HTTPS 反向代理提供 HTTP 服务，管理接口仅限内部访问。在各平台设置下方的回调地址。使用 Socket 或轮询的账号无需设置回调。'
          )
        }}
      </p>
      <ul>
        <li v-for="callback in callbacks" :key="callback.id">
          <strong>{{ accountName(callback.id) }}</strong
          ><br /><code>{{ callback.webhookUrl }}</code>
        </li>
      </ul>
      <h3>{{ text('Connect your Agents', '连接 Agent') }}</h3>
      <div v-for="connection in connections" :key="connection.id">
        <h4>
          {{ state.agents.find((agent) => agent.id === connection.id)?.name }}
        </h4>
        <code>{{ connection.mcpUrl }}</code>
        <p>
          {{
            connection.auth === 'oauth'
              ? text(
                  'Choose OAuth in dot. On the Relanox authorization page, enter the MCP token stored in your environment variable or credential file as the password.',
                  '在 dot 中选择 OAuth。在 Relanox 授权页面，将环境变量或凭据文件中保存的 MCP token 填入密码栏。'
                )
              : connection.auth === 'bearer'
                ? text(
                    'Set the Authorization header to Bearer followed by a space and the MCP token from your environment variable or credential file.',
                    '将 Authorization 请求头设为 Bearer、一个空格，以及环境变量或凭据文件中保存的 MCP token。'
                  )
                : text(
                    'Replace the token placeholder with your actual MCP token after URL encoding it. The resulting URL contains a credential; keep it private.',
                    '将 token 占位符替换为 URL 编码后的实际 MCP token。最终 URL 包含凭据，请妥善保管。'
                  )
          }}
        </p>
      </div>
      <p v-if="state.agents.some((agent) => agent.type === 'muse')">
        {{
          text(
            'For Muse, set credentialsDirectory to the local directory containing your paired device credentials.',
            'Muse 的 credentialsDirectory 填写本地配对凭据所在的目录路径。'
          )
        }}
      </p>
      <h3>{{ text('Check your first reply', '检查第一条回复') }}</h3>
      <p>{{ text('With Relanox running and the platform configured, send a message from an allowed user in the bound conversation. Leave relanox run running and use another terminal for the commands below. The first run creates the database that doctor checks.', '启动 Relanox 并完成平台设置后，用允许的用户在已绑定会话中发送消息。保持 relanox run 运行，在另一个终端执行下方命令。doctor 需要首次启动时创建的数据库。') }}</p>
      <pre><code>relanox status --config relanox.json --json
relanox doctor --config relanox.json --management-url http://127.0.0.1:8788</code></pre>
      <a
        :href="withBase(`/${chinese ? 'zh-CN' : 'en'}/quickstart.html`)"
        target="_blank"
        rel="noopener"
        >{{ text('Quickstart and installation', '安装与快速开始') }}</a
      >
    </div>
  </dialog>
</template>
