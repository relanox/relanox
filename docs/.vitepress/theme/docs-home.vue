<script setup lang="ts">
import { computed } from 'vue'
import { useData, withBase } from 'vitepress'

const { lang } = useData()
const chinese = computed(() => lang.value === 'zh-CN')
const label = (en: string, zh: string): string => (chinese.value ? zh : en)

const link = (path: string): string => {
  const [page, fragment] = path.split('#')
  return withBase(`/${chinese.value ? 'zh-CN' : 'en'}/${page}.html${fragment ? `#${fragment}` : ''}`)
}

const guides = computed(() => [
  {
    title: label('Connect an Agent', '连接 Agent'),
    description: label(
      'Set up dot, Grok Bot or Muse to handle your messages.',
      '让 dot、Grok Bot 或 Muse 接收并处理消息。'
    ),
    path: 'agents'
  },
  {
    title: label('Pictures and files', '收发图片和文件'),
    description: label(
      'Send attachments and receive generated files.',
      '发送附件，接收 Agent 生成的文件。'
    ),
    path: `channels#${label('media-and-native-availability', '媒体与可用性')}`
  },
  {
    title: label('Change settings', '修改配置'),
    description: label(
      'Add accounts, conversations and access rules.',
      '添加账号、会话绑定与访问权限。'
    ),
    path: 'configuration'
  },
  {
    title: label('Deploy and back up', '部署与备份'),
    description: label(
      'Keep Relanox running and your data recoverable.',
      '在服务器运行，管理数据与备份。'
    ),
    path: 'deployment'
  },
  {
    title: label('Find a missing reply', '排查未收到的回复'),
    description: label(
      'Check message status and recover interrupted work.',
      '查看消息状态，恢复中断的任务。'
    ),
    path: `operations#${label('unknown-outcomes-and-replay', '结果不明与重放')}`
  },
  {
    title: label('Logs and monitoring', '日志与运行状态'),
    description: label(
      'Check connections, health and service metrics.',
      '检查连接、健康状态与服务指标。'
    ),
    path: `operations#${label('health-and-observability', '健康与观测')}`
  }
])
</script>

<template>
  <div class="docs-home">
    <section class="docs-intro" aria-labelledby="home-title">
      <div class="docs-intro-copy">
        <h1 id="home-title">
          {{
            label(
              'Use dot, Grok Bot or Muse in your chat apps',
              '在聊天软件中使用 dot、Grok Bot 或 Muse'
            )
          }}
        </h1>
        <p>
          {{
            label(
              'Relanox connects your chat apps to dot, Grok Bot or Muse. Exchange messages, pictures and files in the same conversation, on a service you run yourself.',
              'Relanox 把聊天软件连接到 dot、Grok Bot 或 Muse。在原会话中收发消息、图片和文件，服务运行在你自己的电脑或服务器上。'
            )
          }}
        </p>
        <div class="docs-actions">
          <a class="docs-primary" :href="link('quickstart')"
            >{{ label('Get started', '开始使用') }}
            <span aria-hidden="true">→</span></a
          >
          <a class="docs-secondary" :href="link('connect')"
            >{{ label('Open configurator', '打开连接配置器') }}
            <span aria-hidden="true">→</span></a
          >
          <a class="docs-secondary" href="https://github.com/relanox/relanox">GitHub <span aria-hidden="true">↗</span></a>
        </div>
      </div>
      <div class="docs-start">
        <h2>{{ label('Get your first reply', '收到第一条回复') }}</h2>
        <ol>
          <li>
            <span aria-hidden="true">01</span
            ><a :href="link('channels')"
              >{{ label('Choose a chat app', '选择聊天软件')
              }}<small>{{
                label(
                  'Prepare a bot account and an existing hosted Agent.',
                  '准备机器人账号和已有的云端 Agent。'
                )
              }}</small></a
            >
          </li>
          <li>
            <span aria-hidden="true">02</span
            ><a :href="link('connect')"
              >{{ label('Generate your configuration', '生成连接配置')
              }}<small>{{
                label(
                  'Connect the account, conversation and Agent.',
                  '连接账号、会话与 Agent。'
                )
              }}</small></a
            >
          </li>
          <li>
            <span aria-hidden="true">03</span
            ><a :href="link('quickstart')"
              >{{
                label(
                  'Start Relanox and send a message',
                  '启动 Relanox，发送消息'
                )
              }}<small>{{
                label(
                  'Follow the installation and startup guide.',
                  '按照快速开始完成安装与启动。'
                )
              }}</small></a
            >
          </li>
        </ol>
      </div>
    </section>
    <section class="docs-channels" aria-labelledby="channels-title">
      <div>
        <h2 id="channels-title">
          {{ label('Use the chat app you know', '从熟悉的聊天软件开始') }}
        </h2>
        <p>
          {{
            label(
              'Connect 16 native chat platforms. Check each channel’s setup and media capabilities.',
              '连接 16 个原生聊天平台，查看各通道的配置要求和媒体能力。'
            )
          }}
        </p>
      </div>
      <a :href="link('channels')"
        >{{ label('Explore all channels', '查看全部渠道') }}
        <span aria-hidden="true">→</span></a
      >
      <nav :aria-label="label('Popular channel guides', '常用渠道指南')">
        <a
          v-for="channel in [
            ['Telegram', 'telegram'],
            ['Discord', 'discord'],
            ['Slack', 'slack'],
            [label('Feishu / Lark', '飞书 / Lark'), 'feishu'],
            [label('WeCom', '企业微信'), 'wecom'],
            [label('WeChat', '微信'), 'wechat'],
            [label('DingTalk', '钉钉'), 'dingtalk']
          ]"
          :key="channel[1]"
          :href="link(`channels#${channel[1]}`)"
          >{{ channel[0] }} <span aria-hidden="true">↗</span></a
        >
      </nav>
    </section>
    <section class="docs-guides" aria-labelledby="guides-title">
      <h2 id="guides-title">{{ label('More guides', '使用与管理') }}</h2>
      <div class="docs-guide-list">
        <a v-for="guide in guides" :key="guide.path" :href="link(guide.path)"
          ><div>
            <h3>{{ guide.title }}</h3>
            <p>{{ guide.description }}</p>
          </div>
          <span aria-hidden="true">→</span></a
        >
      </div>
    </section>
    <div class="docs-more">
      <span>{{ label('About Relanox', '了解 Relanox') }}</span
      ><a :href="link('architecture')"
        >{{ label('How messages reach your Agent', '消息如何到达 Agent') }} →</a
      ><a :href="link('development')"
        >{{ label('Contribute to Relanox', '参与开发') }} →</a
      >
    </div>
  </div>
</template>
