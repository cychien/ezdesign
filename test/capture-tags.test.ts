import assert from 'node:assert/strict'
import { test } from 'node:test'
import { type TagEvent, type TagField, allTags, emptyTags, reduceTags } from '../src/extension/dialog/tags.js'

const run = (events: TagEvent[], suggestions: string[] = [], from: TagField = emptyTags) =>
  events.reduce((field, event) => reduceTags(field, event, suggestions), from)

test('Enter and either comma add a tag; the draft keeps what follows', () => {
  assert.deepEqual(run([{ type: 'input', value: 'hero' }, { type: 'enter' }]), { ...emptyTags, chips: ['hero'] })
  assert.deepEqual(run([{ type: 'input', value: 'Landing Page,卡片，ca' }]), {
    ...emptyTags,
    chips: ['Landing Page', '卡片'],
    draft: 'ca',
  })
})

test('a tag already there by key is not added again, and blank ones never are', () => {
  const field = run([{ type: 'input', value: 'Hero, hero ,ＨＥＲＯ,  ,x' }])
  assert.deepEqual(field.chips, ['Hero'])
  assert.equal(field.draft, 'x')
})

test('arrows cycle the suggestions; Enter takes the highlighted one', () => {
  const suggestions = ['card', 'Carousel', 'cart']
  const down = run([{ type: 'input', value: 'ca' }, { type: 'arrow', delta: 1 }], suggestions)
  assert.equal(down.highlighted, 0)
  assert.equal(reduceTags(down, { type: 'arrow', delta: -1 }, suggestions).highlighted, 2)
  assert.deepEqual(reduceTags(reduceTags(down, { type: 'arrow', delta: 1 }, suggestions), { type: 'enter' }, suggestions).chips, ['Carousel'])
  assert.equal(run([{ type: 'arrow', delta: 1 }]).highlighted, null, 'no suggestions, nothing to highlight')
})

test('Backspace on an empty draft removes the last chip, never a locked one', () => {
  const locked = reduceTags(emptyTags, { type: 'lock', names: ['hero', 'Card'] }, [])
  const field = run([{ type: 'input', value: 'new,' }, { type: 'backspace' }, { type: 'backspace' }], [], locked)
  assert.deepEqual(allTags(field), ['hero', 'Card'])
  assert.deepEqual(run([{ type: 'input', value: 'HERO,card,' }], [], locked).chips, [], 'locked tags are not added twice')
  assert.deepEqual(run([{ type: 'input', value: 'a,b,' }, { type: 'remove', index: 0 }]).chips, ['b'])
})
