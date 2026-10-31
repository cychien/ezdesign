import assert from 'node:assert/strict'
import { test } from 'node:test'
import { detectSlash, filterCommands, menuPosition } from '../src/client/slash.js'
import type { SlashCommand } from '../src/client/slash.js'

test('a slash opens the menu at the start of a word', () => {
  assert.deepEqual(detectSlash('/'), { start: 0, query: '' })
  assert.deepEqual(detectSlash('/fi'), { start: 0, query: 'fi' })
  assert.deepEqual(detectSlash('看這裡 /file'), { start: 4, query: 'file' })
  // The spacer after a chip is a non-breaking space, so it has to count as one.
  assert.deepEqual(detectSlash(' /f'), { start: 1, query: 'f' })
})

// The rule that keeps the menu out of the way of ordinary text. Without it every
// url and path in a comment would open it.
test('a slash inside a word is just a character', () => {
  assert.equal(detectSlash('http://localhost:5173'), null)
  assert.equal(detectSlash('src/client'), null)
  assert.equal(detectSlash('a/b'), null)
})

test('a slash after clause punctuation opens the menu, after path punctuation it does not', () => {
  assert.deepEqual(detectSlash('標題放大，/fi'), { start: 5, query: 'fi' })
  assert.deepEqual(detectSlash('bigger,/file'), { start: 7, query: 'file' })
  assert.deepEqual(detectSlash('（/el'), { start: 1, query: 'el' })
  assert.deepEqual(detectSlash('完成。$re', '$'), { start: 3, query: 're' })
  assert.equal(detectSlash('./src'), null)
  assert.equal(detectSlash('~/code'), null)
  assert.equal(detectSlash('user@host:/var'), null)
  assert.equal(detectSlash('a-/b'), null)
})

test('the query ends where the command name would', () => {
  assert.equal(detectSlash('/file 之後'), null, 'a space closes it')
  assert.equal(detectSlash(`/${'x'.repeat(30)}`), null, 'prose is not a command name')
  assert.equal(detectSlash('no slash here'), null)
})

test('the last slash is the live one', () => {
  assert.deepEqual(detectSlash('/a /b'), { start: 3, query: 'b' })
})

const command = (id: string, label: string, keywords: string[]): SlashCommand => ({
  id,
  label,
  keywords,
  icon: [],
  run: () => {},
})

const COMMANDS = [
  command('file', '附加檔案', ['attach', 'upload', '圖片']),
  command('viewport', '切換寬度', ['size', 'mobile']),
]

test('an empty query offers everything', () => {
  assert.deepEqual(filterCommands(COMMANDS, '').length, 2)
})

test('filtering matches the id, the label or a keyword', () => {
  assert.deepEqual(
    filterCommands(COMMANDS, 'fi').map((c) => c.id),
    ['file'],
  )
  assert.deepEqual(
    filterCommands(COMMANDS, '圖片').map((c) => c.id),
    ['file'],
    'keywords carry the terms the label does not use',
  )
  assert.deepEqual(
    filterCommands(COMMANDS, '寬度').map((c) => c.id),
    ['viewport'],
  )
  assert.deepEqual(filterCommands(COMMANDS, 'zzz'), [])
})

const skill = (id: string, description: string): SlashCommand => ({ id, label: id, keywords: [], description, run: () => {} })

const SKILLS = [
  skill('architect', 'Plan the system before building it, delivered in several passes.'),
  skill('create-verification-skill', 'Write a verification skill for a repo.'),
  skill('everyday-do', 'Run an everyday task.'),
  skill('guard', 'Hard rules for every agent, enforced by a verifier.'),
  skill('verify', 'Prove a change works end to end.'),
]

test('a name match ranks by where the query starts, and prose never joins it', () => {
  assert.deepEqual(
    filterCommands(SKILLS, 'ver').map((c) => c.id),
    ['verify', 'create-verification-skill', 'everyday-do'],
  )
})

test('a description is searched by word start once no name or keyword matches', () => {
  assert.deepEqual(
    filterCommands(SKILLS, 'end to').map((c) => c.id),
    ['verify'],
  )
  assert.deepEqual(
    filterCommands(SKILLS, 'verif').map((c) => c.id),
    ['verify', 'create-verification-skill'],
  )
  assert.deepEqual(
    filterCommands(SKILLS, 'livered').map((c) => c.id),
    [],
    'mid-word in prose is not a match',
  )
})

test('filtering ignores case and surrounding space', () => {
  assert.deepEqual(
    filterCommands(COMMANDS, ' UPLOAD ').map((c) => c.id),
    ['file'],
  )
})


// `/new` is only meaningful while an ACP agent is attached, and the menu is built
// once for the life of the composer - so availability is asked at filter time.
test('a disabled command is off the menu, matched or not', () => {
  let attached = false
  const commands: SlashCommand[] = [
    ...COMMANDS,
    { ...command('new', '新對話', ['clear']), enabled: () => attached },
  ]
  assert.deepEqual(
    filterCommands(commands, '').map((c) => c.id),
    ['file', 'viewport'],
  )
  assert.deepEqual(filterCommands(commands, 'new'), [])
  attached = true
  assert.deepEqual(
    filterCommands(commands, 'new').map((c) => c.id),
    ['new'],
  )
  assert.equal(filterCommands(commands, '').length, 3)
})

// A second menu shares the box with the first. They cannot both be open: a
// trigger only counts at the start of the word being typed, so at any caret at
// most one of them is the one being typed.
test('a trigger only fires as its own character', () => {
  assert.deepEqual(detectSlash('$dat', '$'), { start: 0, query: 'dat' })
  assert.equal(detectSlash('/file', '$'), null)
  assert.equal(detectSlash('$dat', '/'), null)
})

test('the same word-boundary rule applies to any trigger', () => {
  assert.equal(detectSlash('cost$5', '$'), null, 'mid-word is not a trigger')
  assert.deepEqual(detectSlash('run $verify', '$'), { start: 4, query: 'verify' })
  assert.equal(detectSlash('$two words', '$'), null, 'a space ends the query')
})

test('the menu opens under its trigger, or over it when the trigger sits low', () => {
  const view = { width: 1000, height: 800 }
  const at = { left: 100, top: 100, bottom: 120 }
  assert.deepEqual(menuPosition(at, { width: 240, height: 120 }, view, 1), { left: 100, top: 126 })
  assert.deepEqual(
    menuPosition({ left: 950, top: 700, bottom: 720 }, { width: 240, height: 120 }, view, 1),
    { left: 752, top: 574 },
  )
})

// In a canvas frame the menu is drawn at the inverse of the board's zoom, so its
// gap and margins are too: they hold their size on screen.
test('a scaled menu keeps its gaps in step with its scale', () => {
  const view = { width: 1000, height: 800 }
  const at = { left: 100, top: 100, bottom: 120 }
  assert.deepEqual(menuPosition(at, { width: 120, height: 60 }, view, 0.5), { left: 100, top: 123 })
  assert.deepEqual(
    menuPosition({ left: 950, top: 700, bottom: 720 }, { width: 480, height: 240 }, view, 2),
    { left: 504, top: 448 },
  )
})
