import { getRelativeLocaleUrl } from 'astro:i18n'
import { DEFAULT_LOCALE, MESSAGES, type Locale } from './locales'

export * from './locales'

export const localeUrls = (pathname: string, current: Locale): Record<Locale, string> => {
  const path = current === DEFAULT_LOCALE ? pathname : pathname.slice(current.length + 1) || '/'
  return Object.fromEntries(Object.keys(MESSAGES).map((locale) => [locale, getRelativeLocaleUrl(locale, path)])) as Record<Locale, string>
}
