import { defineConfig } from 'astro/config'

export default defineConfig({
  devToolbar: { enabled: false },
  i18n: {
    locales: ['en', 'zh-tw'],
    defaultLocale: 'en',
    routing: { prefixDefaultLocale: false },
  },
})
