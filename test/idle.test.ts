import assert from 'node:assert/strict'
import { test } from 'node:test'
import { IdleCount } from '../src/idle.js'

test('idle only after the limit of quiet checks in a row', () => {
  const idle = new IdleCount(3)
  assert.equal(idle.observe(false), false)
  assert.equal(idle.observe(false), false)
  assert.equal(idle.observe(false), true)
})

test('anything in use starts the count over', () => {
  const idle = new IdleCount(2)
  idle.observe(false)
  idle.observe(true)
  assert.equal(idle.observe(false), false)
  assert.equal(idle.observe(false), true)
})

test('a night asleep is one check, so a shell reconnecting on wake is not reaped', () => {
  const idle = new IdleCount(30)
  idle.observe(true)
  assert.equal(idle.observe(false), false, 'the first check after waking, its stream not back yet')
  assert.equal(idle.observe(true), false)
})
