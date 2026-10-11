import DefaultTheme from "vitepress/theme";
import { inBrowser } from "vitepress";
import type { Theme } from "vitepress";
import { applyLanguagePreference } from "../language.js";
import "./style.css";

export default {
  extends: DefaultTheme,
  enhanceApp({ router, siteData }) {
    if (inBrowser) {
      router.onAfterRouteChange = () => {
        applyLanguagePreference(siteData.value.base);
      };
    }
  },
} satisfies Theme;
