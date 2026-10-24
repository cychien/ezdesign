import type { Announcement } from '../announcement.js'
import template from './template.svg'

/** Newest first. Only the newest published one is ever shown. */
export const ANNOUNCEMENTS: readonly Announcement[] = [
  {
    id: 'template',
    draft: true,
    media: { src: template, alt: '在頁面上標註元素的示意圖' },
    title: '新功能標題',
    body: '用一兩句話說明這次更新帶來什麼，以及使用者可以怎麼開始用。超過三行的部分會被截掉。',
    action: { label: '了解更多', href: 'https://github.com/cychien/ezdesign/releases' },
  },
]
