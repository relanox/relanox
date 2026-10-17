import { defineConfig } from 'vitepress'
import { applyLanguagePreference } from './language.js'
import { navigation } from './navigation.js'

const base = '/'

export default defineConfig({
  title: 'Relanox',
  description: 'Connect native chat apps to dot, Grok and Muse with Relanox.',
  base,
  srcExclude: ['README.md', 'local/**', 'site/**'],
  cleanUrls: false,
  head: [
    [
      'script',
      {},
      `(${applyLanguagePreference.toString()})(${JSON.stringify(base)});`
    ]
  ],
  locales: {
    en: { label: 'English', lang: 'en', themeConfig: navigation(false) },
    'zh-CN': {
      label: '简体中文',
      lang: 'zh-CN',
      description: '通过 Relanox 将原生聊天平台连接到 dot、Grok 和 Muse。',
      themeConfig: navigation(true)
    }
  },
  themeConfig: {
    socialLinks: [
      { icon: 'github', link: 'https://github.com/relanox/relanox' }
    ],
    search: {
      provider: 'local',
      options: {
        locales: {
          'zh-CN': {
            translations: {
              button: { buttonText: '搜索文档', buttonAriaLabel: '搜索文档' },
              modal: {
                displayDetails: '显示详细结果',
                resetButtonTitle: '清除搜索',
                backButtonTitle: '返回',
                noResultsText: '没有找到相关结果',
                footer: {
                  selectText: '选择',
                  navigateText: '切换',
                  closeText: '关闭'
                }
              }
            }
          }
        }
      }
    }
  }
})
