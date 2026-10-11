<script setup lang="ts">
import { CHANNELS } from './channels.js'
import { addChat, removeChat } from './model.js'
import type { AgentState, ChannelState } from './types.js'

const props = defineProps<{
  channel: ChannelState
  agents: AgentState[]
  chinese: boolean
}>()

const text = (en: string, zh: string): string => (props.chinese ? zh : en)
</script>

<template>
  <div class="chat-bindings">
    <div v-if="channel.channel === 'wecom'" class="discovery-help">
      <strong>{{
        text('First time finding a chat ID?', '第一次获取聊天 ID？')
      }}</strong>
      <p class="field-hint">
        {{
          text(
            'Fill in the bot ID and secret variable below, then download this draft. On your server, set the bot secret and stop any running connection for the same bot. Run:',
            '先填写下方机器人 ID 与密钥变量名，下载当前草稿。在服务器设置机器人密钥，并停止同一机器人的已有连接，然后运行：'
          )
        }}
      </p>
      <pre><code>node apps/cli/dist/main.js discover --config relanox.json --account {{ channel.id }} --timeout 120</code></pre>
      <p class="field-hint">
        {{
          text(
            'After discovery_connected appears, send a message to the bot in the target conversation. Copy chatId below and senderId into allowed users. This command prints IDs only and stops after 120 seconds or Ctrl+C. Fill the remaining fields and download the final configuration before starting the service.',
            '出现 discovery_connected 后，在目标聊天中给机器人发消息，将输出的 chatId 填到下方，senderId 填入允许用户。命令只输出 ID，120 秒后退出，也可按 Ctrl+C。补全信息后重新下载配置，再启动服务。'
          )
        }}
      </p>
    </div>
    <fieldset
      v-for="(chat, index) in channel.chats"
      :key="chat.id"
      class="chat-fields"
    >
      <legend>{{ text(`Chat ${index + 1}`, `聊天 ${index + 1}`) }}</legend>
      <label :for="`${channel.id}-${chat.id}-chat`">{{
        text('Chat ID', '聊天 ID')
      }}</label>
      <input
        :id="`${channel.id}-${chat.id}-chat`"
        v-model="chat.chatId"
        :placeholder="
          CHANNELS.find((entry) => entry.id === channel.channel)?.chatExample
        "
      />
      <label :for="`${channel.id}-${chat.id}-thread`">{{
        text('Thread ID (optional)', '话题 / 线程 ID（可选）')
      }}</label>
      <input
        :id="`${channel.id}-${chat.id}-thread`"
        v-model="chat.threadId"
        :aria-describedby="`${channel.id}-thread-hint`"
      />
      <label :for="`${channel.id}-${chat.id}-agent`">{{
        text('Receiving Agent', '接收 Agent')
      }}</label>
      <select :id="`${channel.id}-${chat.id}-agent`" v-model="chat.endpointId">
        <option disabled value="">
          {{ text('Choose an Agent', '选择 Agent') }}
        </option>
        <option v-for="agent in agents" :key="agent.id" :value="agent.id">
          {{ agent.name || agent.id }}
        </option>
      </select>
      <button
        v-if="channel.chats.length > 1"
        class="connection-link"
        :aria-label="text(`Remove chat ${index + 1}`, `移除聊天 ${index + 1}`)"
        @click="removeChat(channel, chat.id)"
      >
        {{ text('Remove chat', '移除此聊天') }}
      </button>
    </fieldset>
    <p :id="`${channel.id}-thread-hint`" class="field-hint">
      {{
        text(
          'An empty thread ID matches only messages without a thread. Add a separate binding for each topic or thread; it does not include all child threads.',
          '线程 ID 留空只匹配不带线程的消息，不包含下面所有话题或帖子。每个话题或线程需单独添加绑定。'
        )
      }}
    </p>
    <button
      class="connection-link"
      @click="addChat(channel, agents[0]?.id ?? '')"
    >
      {{ text('Add chat', '添加聊天') }}
    </button>
  </div>
</template>
