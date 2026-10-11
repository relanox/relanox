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
      page(label('Guide', '开始使用'), 'getting-started'),
      page(label('Operations', '部署与运维'), 'operations'),
      page(label('Development', '开发维护'), 'development')
    ],
    sidebar: [
      {
        text: label('Guide', '使用指南'),
        items: [
          page(label('Getting started', '快速开始'), 'getting-started'),
          page(label('Configuration & CLI', '配置与命令'), 'configuration'),
          page(label('Connect dot / Grok', '连接 dot / Grok'), 'agents'),
          page(label('Media transfer', '媒体传输'), 'media'),
          page(label('Operations', '部署与运维'), 'operations')
        ]
      },
      {
        text: label('Channels', '消息渠道'),
        collapsed: true,
        items: channels.map(([name, file]) => page(name, `channels/${file}`))
      },
      {
        text: label('Development & reference', '开发与参考'),
        items: [
          page(label('Architecture', '架构'), 'architecture'),
          page(label('Development', '开发维护'), 'development'),
          page('Core API', 'reference/core'),
          page(
            label('SDK & storage contracts', 'SDK 与存储契约'),
            'reference/sdk'
          ),
          page(label('Observability', '可观测性'), 'reference/observability'),
          page(
            label('Third-party licenses', '第三方许可'),
            'reference/licenses'
          )
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
