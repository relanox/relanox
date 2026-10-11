<script setup lang="ts">
import { withBase } from 'vitepress'
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
    <p v-if="channel.channel === 'wecom'" class="field-hint discovery-help">
      {{
        text(
          'Need the chat ID? Fill in your bot details, then follow the ',
          '还不知道聊天 ID？先填写机器人信息，再按'
        )
      }}
      <a
        class="connection-link"
        :href="withBase(`/${chinese ? 'zh-CN' : 'en'}/channels/wecom.html`)"
        target="_blank"
        rel="noopener"
        >{{ text('WeCom guide', '企业微信指南') }}</a
      >
      {{ text(' to find it.', '获取。') }}
    </p>
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
          'Leave blank for the main chat. Add each topic or thread you want to connect separately.',
          '留空只接收主聊天的消息。要接入话题或帖子，请逐个添加。'
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
