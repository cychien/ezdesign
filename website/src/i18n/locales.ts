import { en, type Messages } from './en'
import { zhTw } from './zh-tw'

export const MESSAGES = { en, 'zh-tw': zhTw } satisfies Record<string, Messages>

export type Locale = keyof typeof MESSAGES

export const DEFAULT_LOCALE: Locale = 'en'

export const LOCALE_COOKIE = 'locale'

export const isLocale = (value: string | undefined): value is Locale => !!value && value in MESSAGES

export const messages = (locale: string | undefined): Messages => (isLocale(locale) ? MESSAGES[locale] : en)
