import { defineConfig } from 'astro/config'

export default defineConfig({
  site: 'https://ezdesign.dev',
  devToolbar: { enabled: false },
  i18n: {
    locales: ['en', 'zh-tw'],
    defaultLocale: 'en',
    routing: { prefixDefaultLocale: false },
  },
})
