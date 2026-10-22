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
      <h2>{{ text('Set up your connection', '完成接入') }}</h2>
      <p>
        {{
          text(
            'Download relanox.json. This page creates a fresh draft. Back up an existing configuration and merge changes while preserving account IDs, endpoint IDs and secret references.',
            '下载 relanox.json。本页生成全新草稿；已有配置请先备份，合并修改时保留账号 ID、端点 ID 和凭据引用。'
          )
        }}
      </p>
      <p>
        {{
          text(
            'Secret inputs are environment variable names or file paths, never credential values. Set the actual values on the server. An environment variable takes precedence over a file when both are configured.',
            '凭据输入框填写环境变量名或文件路径，不填写凭据本身。在服务器设置实际值，同时填写时环境变量优先。'
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
            'Complete the missing fields shown in Connection details. CLI validation is authoritative; this page only checks basic draft fields.',
            '请补齐连接信息中提示的字段。页面仅检查基础字段，以 CLI 校验结果为准。'
          )
        }}
      </p>
      <p>
        {{
          text(
            'Expose the HTTP listener behind HTTPS. Keep the management listener private. Configure each platform callback below; socket and polling accounts do not need a callback.',
            '通过 HTTPS 反向代理公开 HTTP 监听地址，管理监听地址保持私有。按下面地址设置平台回调；Socket 和轮询账号不需要回调。'
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
                  'Choose OAuth in dot. Use the resolved MCP token as the password on the Relanox authorization page.',
                  '在 dot 选择 OAuth，并在 Relanox 授权页面使用解析后的 MCP token 作为密码。'
                )
              : connection.auth === 'bearer'
                ? text(
                    'Use the resolved MCP token in the Authorization: Bearer header.',
                    '在 Authorization: Bearer 请求头中填写解析后的 MCP token。'
                  )
                : text(
                    'Replace the token placeholder with the URL-encoded resolved MCP token. The resulting URL contains a credential; keep it private.',
                    '将 token 占位符替换为 URL 编码后的实际 MCP token。最终 URL 包含凭据，请妥善保管。'
                  )
          }}
        </p>
      </div>
      <p v-if="state.agents.some((agent) => agent.type === 'muse')">
        {{
          text(
            'Muse credentialsDirectory is a local path to paired credentials, not a secret reference.',
            'Muse 的 credentialsDirectory 是配对凭据的本地路径，不是凭据引用。'
          )
        }}
      </p>
      <h3>{{ text('Check your first reply', '检查第一条回复') }}</h3>
      <p>{{ text('After startup and external setup, send a message from an allowed user in the bound conversation. Keep run active and inspect status in another terminal. Run doctor after the database has been created by the first run.', '完成启动与外部接入后，用允许的用户在已绑定会话中发送消息。保持 run 运行，在另一个终端查看状态。首次 run 创建数据库后，再运行 doctor。') }}</p>
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
