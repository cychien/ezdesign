import type { Locale } from '../i18n/locales'

export const OG_IMAGE = { width: 1200, height: 630, type: 'image/png' }

export const ogImagePath = (locale: Locale) => `/og/${locale}.png`
