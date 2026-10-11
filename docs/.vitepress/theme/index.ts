import DefaultTheme from 'vitepress/theme'
import { inBrowser } from 'vitepress'
import type { Theme } from 'vitepress'
import { applyLanguagePreference } from '../language.js'
import './style.css'

export default {
  extends: DefaultTheme,
  enhanceApp({ router, siteData }): void {
    if (inBrowser) {
      router.onAfterRouteChange = (): void => {
        applyLanguagePreference(siteData.value.base)
      }
    }
  }
} satisfies Theme
