import assert from 'node:assert/strict'
import { test } from 'node:test'
import { foldItemDirectives } from '../src/item-directives.js'
import type { Annotation, BatchTarget } from '../src/protocol.js'

const item = (comment: string, extra: Partial<Annotation> = {}): Annotation => ({
  id: comment,
  kind: 'element',
  comment,
  anchor: {},
  createdAt: 0,
  ...extra,
})
const app: BatchTarget = { kind: 'app', label: 'App' }
const canvas: BatchTarget = { kind: 'canvas', canvasId: 'c1', label: '首頁探索' }

test('each comment\'s skills fold into the batch\'s list, once each, markers renumbered to it', () => {
  const folded = foldItemDirectives(['review'], undefined, [
    item('用 [skill 1] 和 [skill 2]', { skills: ['polish', 'review'] }),
    item('再 [skill 1]', { skills: ['audit'] }),
    item('沒有'),
  ])
  assert.deepEqual(folded.skills, ['review', 'polish', 'audit'])
  assert.deepEqual(
    folded.items.map((i) => i.comment),
    ['用 [skill 2] 和 [skill 1]', '再 [skill 3]', '沒有'],
  )
  assert.ok(folded.items.every((i) => i.skills === undefined && i.target === undefined))
})

test('a marker naming nothing in its own box stays as it was written', () => {
  const folded = foldItemDirectives([], undefined, [item('[skill 2] 留著', { skills: ['polish'] })])
  assert.deepEqual(folded.items[0]!.comment, '[skill 2] 留著')
  assert.deepEqual(folded.skills, [])
})

test('the note\'s place wins; else the first comment\'s; a comment naming another place keeps it as words', () => {
  assert.deepEqual(foldItemDirectives([], undefined, [item('a'), item('放 [target 1]', { target: canvas })]).target, canvas)
  const noteWins = foldItemDirectives([], app, [item('放 [target 1]', { target: canvas }), item('這裡 [target 1]', { target: app })])
  assert.deepEqual(noteWins.target, app)
  assert.deepEqual(noteWins.items.map((i) => i.comment), ['放 #首頁探索', '這裡 [target 1]'])
})
