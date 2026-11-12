/** What a composer offers under `$` (skills the agent can run) and `#` (where
 *  the result goes), and the two `/` rows that lead there. One definition for
 *  every composer - the note box, a queued comment being edited, and the popup
 *  on the page - so the three never drift apart in what they call things. */

import DollarSquareIcon from '@hugeicons/core-free-icons/DollarSquareIcon'
import HashtagIcon from '@hugeicons/core-free-icons/HashtagIcon'
import type { IconNode } from './icon.js'
import type { SlashCommand } from './slash.js'
import type { BatchTarget } from '../protocol.js'

export interface SkillInfo {
  name: string
  description: string
}

/** No glyph and no source label. The row is the name the user is about to
 *  type, and a column of identical marks beside a list of skills says only that
 *  they are all skills, which the `$` already said. */
export function skillCommands(skills: readonly SkillInfo[], insert: (name: string) => void): SlashCommand[] {
  return skills.map((skill) => ({
    id: skill.name,
    label: skill.name,
    keywords: [],
    description: skill.description,
    run: () => insert(skill.name),
  }))
}

const PLACE_WORDS: Record<BatchTarget['kind'], { hint: string; keywords: string[] }> = {
  app: { hint: '改到實際的 app', keywords: ['app', '網站', '頁面', '程式'] },
  canvas: { hint: 'canvas', keywords: ['canvas', '畫布'] },
  'new-canvas': { hint: '建立新的 canvas', keywords: ['new', 'canvas', '新', '畫布'] },
}

export function placeCommands(places: readonly BatchTarget[], insert: (place: BatchTarget) => void): SlashCommand[] {
  return places.map((place) => ({
    // Never the canvas id: it is hex, and `#a1b2c3` typed as a colour would
    // match the canvas whose id happens to start that way.
    id: place.kind === 'canvas' ? place.label : place.kind,
    label: place.label,
    ...PLACE_WORDS[place.kind],
    run: () => insert(place),
  }))
}

/** The `/` rows for users who only know `/`. Typed rather than inserted, so
 *  the `$` or `#` menu opens right there. */
export function directiveRows(offers: { skills: () => boolean; places: () => boolean }): SlashCommand[] {
  return [
    {
      id: 'skills',
      label: 'Skills',
      hint: '輸入 $ 使用 skill',
      keywords: ['skill', 'skills', '$', '技能'],
      icon: DollarSquareIcon as IconNode,
      enabled: offers.skills,
      run: () => document.execCommand('insertText', false, '$'),
    },
    {
      id: 'target',
      label: 'Place',
      hint: '輸入 # 指定結果放到哪',
      keywords: ['place', 'target', 'destination', 'app', 'canvas', '#', '放到', '位置', '畫布'],
      icon: HashtagIcon as IconNode,
      enabled: offers.places,
      run: () => document.execCommand('insertText', false, '#'),
    },
  ]
}
