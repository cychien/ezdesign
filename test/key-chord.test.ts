import assert from 'node:assert/strict'
import { test } from 'node:test'
import { type KeyChord, plainKeyMatches } from '../src/client/key-chord.js'

const press = (key: string, code: string, mods: Partial<KeyChord> = {}): KeyChord => ({
  key,
  code,
  metaKey: false,
  ctrlKey: false,
  ...mods,
})

test('a Latin layout matches by the character typed', () => {
  assert.equal(plainKeyMatches(press('e', 'KeyE'), 'E'), true)
  assert.equal(plainKeyMatches(press('E', 'KeyE'), 'e'), true)
  assert.equal(plainKeyMatches(press('Escape', 'Escape'), 'Escape'), true)
})

test('Zhuyin or an IME matches by the physical key, letters and digits alike', () => {
  assert.equal(plainKeyMatches(press('ㄍ', 'KeyE'), 'E'), true)
  assert.equal(plainKeyMatches(press('ㄐ', 'KeyR'), 'R'), true)
  assert.equal(plainKeyMatches(press('Process', 'KeyN'), 'n'), true)
  assert.equal(plainKeyMatches(press('ㄅ', 'Digit1'), '1'), true)
  assert.equal(plainKeyMatches(press('ㄍ', 'KeyE'), 'R'), false)
})

test('a layout that types ASCII keeps its own letters over the key position', () => {
  // Dvorak: the cap printed "." sits where QWERTY has E.
  assert.equal(plainKeyMatches(press('.', 'KeyE'), 'E'), false)
  assert.equal(plainKeyMatches(press('e', 'KeyD'), 'E'), true)
})

test('a modifier or a forwarded chord without a code never matches by position', () => {
  assert.equal(plainKeyMatches(press('ㄍ', 'KeyE', { metaKey: true }), 'E'), false)
  assert.equal(plainKeyMatches(press('e', 'KeyE', { ctrlKey: true }), 'E'), false)
  assert.equal(plainKeyMatches(press('ㄍ', ''), 'E'), false)
})
