import { type TagName, normalizeTag, tagKey } from '../../library/policy.js'

export interface TagField {
  locked: TagName[]
  chips: TagName[]
  draft: string
  highlighted: number | null
}

export type TagEvent =
  | { type: 'input'; value: string }
  | { type: 'enter' }
  | { type: 'backspace' }
  | { type: 'arrow'; delta: 1 | -1 }
  | { type: 'pick'; name: string }
  | { type: 'remove'; index: number }
  | { type: 'lock'; names: readonly string[] }

export const emptyTags: TagField = { locked: [], chips: [], draft: '', highlighted: null }

const SEPARATOR = /[,，]/

export function allTags(field: TagField): TagName[] {
  return [...field.locked, ...field.chips]
}

function add(field: TagField, raw: string): TagField {
  const name = normalizeTag(raw)
  if (name === null || allTags(field).some((t) => tagKey(t) === tagKey(name))) return field
  return { ...field, chips: [...field.chips, name] }
}

export function reduceTags(field: TagField, event: TagEvent, suggestions: readonly string[]): TagField {
  switch (event.type) {
    case 'input': {
      const parts = event.value.split(SEPARATOR)
      const draft = parts.pop() ?? ''
      const next = parts.reduce(add, field)
      return { ...next, draft, highlighted: null }
    }
    case 'enter': {
      const picked = field.highlighted === null ? field.draft : suggestions[field.highlighted]
      return { ...add(field, picked ?? field.draft), draft: '', highlighted: null }
    }
    case 'backspace':
      return field.draft === '' && field.chips.length
        ? { ...field, chips: field.chips.slice(0, -1), highlighted: null }
        : field
    case 'arrow': {
      if (suggestions.length === 0) return { ...field, highlighted: null }
      const from = field.highlighted ?? (event.delta === 1 ? -1 : suggestions.length)
      return { ...field, highlighted: (from + event.delta + suggestions.length) % suggestions.length }
    }
    case 'pick':
      return { ...add(field, event.name), draft: '', highlighted: null }
    case 'remove':
      return { ...field, chips: field.chips.filter((_, i) => i !== event.index) }
    case 'lock': {
      const locked: TagName[] = []
      for (const raw of event.names) {
        const name = normalizeTag(raw)
        if (name && !locked.some((t) => tagKey(t) === tagKey(name))) locked.push(name)
      }
      const chips = field.chips.filter((c) => !locked.some((t) => tagKey(t) === tagKey(c)))
      return { ...field, locked, chips }
    }
  }
}
