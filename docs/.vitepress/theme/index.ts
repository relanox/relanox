import DefaultTheme from 'vitepress/theme'
import { inBrowser } from 'vitepress'
import type { Theme } from 'vitepress'
import { applyLanguagePreference } from '../language.js'
import ConnectionConfigurator from '../configurator/connection-configurator.vue'
import DocsHome from './docs-home.vue'
import './style.css'
import '../configurator/style.css'

export default {
  extends: DefaultTheme,
  enhanceApp({ app, router, siteData }): void {
    app.component('ConnectionConfigurator', ConnectionConfigurator)
    app.component('DocsHome', DocsHome)
    if (inBrowser) {
      router.onAfterRouteChange = (): void => {
        applyLanguagePreference(siteData.value.base)
      }
    }
  }
} satisfies Theme
