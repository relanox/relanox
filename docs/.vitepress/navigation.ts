import type { DefaultTheme } from 'vitepress'

export function navigation(chinese: boolean): DefaultTheme.Config {
  const label = (english: string, simplifiedChinese: string): string =>
    chinese ? simplifiedChinese : english

  const base = label('/en/', '/zh-CN/')

  const page = (
    text: string,
    file: string
  ): { text: string; link: string } => ({
    text,
    link: `${base}${file}`
  })

  const channels = [
    ['Telegram', 'telegram'],
    ['Discord', 'discord'],
    ['Slack', 'slack'],
    [label('Feishu / Lark', '飞书 / Lark'), 'feishu'],
    [label('WeCom', '企业微信'), 'wecom'],
    [label('DingTalk', '钉钉'), 'dingtalk'],
    ['QQ', 'qq'],
    ['Microsoft Teams', 'msteams'],
    ['WhatsApp', 'whatsapp'],
    ['Google Chat', 'googlechat'],
    ['LINE', 'line'],
    ['Matrix', 'matrix'],
    ['Mattermost', 'mattermost'],
    ['Signal', 'signal'],
    ['IRC', 'irc']
  ] as const

  return {
    nav: [
      page(label('Configurator', '连接配置器'), 'connect'),
      page(label('Get started', '开始使用'), 'getting-started'),
      page(label('Choose a channel', '选择渠道'), 'channels/'),
      page(label('Manage Relanox', '日常管理'), 'operations')
    ],
    sidebar: [
      {
        text: label('Get started', '开始使用'),
        items: [
          page(label('Quick start', '快速开始'), 'getting-started'),
          page(label('Connection configurator', '连接配置器'), 'connect'),
          page(label('How it works', '消息如何到达 Agent'), 'architecture'),
          page(label('Connect an Agent', '连接 Agent'), 'agents'),
          page(label('Change settings', '修改配置'), 'configuration'),
          page(label('Send pictures and files', '收发图片和文件'), 'media')
        ]
      },
      {
        text: label('Connect a chat app', '连接聊天软件'),
        collapsed: true,
        items: [
          page(label('Choose a channel', '选择消息渠道'), 'channels/'),
          ...channels.map(([name, file]) => page(name, `channels/${file}`))
        ]
      },
      {
        text: label('Daily use', '日常使用'),
        items: [
          page(label('Deployment and backups', '部署与备份'), 'operations')
        ]
      },
      {
        text: label('Technical reference', '技术参考'),
        collapsed: true,
        items: [
          page(
            label('Configuration and CLI', '配置与 CLI'),
            'reference/configuration'
          ),
          page(label('Agent protocols', 'Agent 协议'), 'reference/agents'),
          page(label('Channel settings', '渠道配置'), 'reference/channels'),
          page(label('Media transfer', '媒体传输'), 'reference/media'),
          page(
            label('Message status and recovery', '消息状态与恢复'),
            'reference/core'
          ),
          page(
            label('Logs and monitoring', '日志与运行状态'),
            'reference/observability'
          )
        ]
      },
      {
        text: label('Contribute and extend', '贡献与扩展'),
        collapsed: true,
        items: [
          page(label('Contributing', '贡献指南'), 'development'),
          page(label('Build an integration', '扩展接入'), 'reference/sdk'),
          page(label('Licenses', '许可证'), 'reference/licenses')
        ]
      }
    ],
    outline: { level: [2, 3], label: label('On this page', '本页目录') },
    docFooter: {
      prev: label('Previous', '上一页'),
      next: label('Next', '下一页')
    },
    returnToTopLabel: label('Return to top', '返回顶部'),
    sidebarMenuLabel: label('Menu', '目录'),
    darkModeSwitchLabel: label('Appearance', '外观'),
    lightModeSwitchTitle: label('Switch to light theme', '切换到浅色模式'),
    darkModeSwitchTitle: label('Switch to dark theme', '切换到深色模式'),
    langMenuLabel: label('Change language', '切换语言'),
    skipToContentLabel: label('Skip to content', '跳至正文'),
    footer: {
      message: label('Released under the MIT License.', '以 MIT 许可证发布。')
    }
  }
}
