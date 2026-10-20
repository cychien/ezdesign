import assert from 'node:assert/strict'
import { test } from 'node:test'
import { designHarnessEnabled } from '../src/truth.js'

const ENV = 'EZDESIGN_DESIGN_HARNESS'

test('C1 the harness flag is read the way people set it', () => {
  for (const off of [undefined, '', '0', 'false', 'FALSE']) {
    assert.equal(designHarnessEnabled({ [ENV]: off }), false, `${JSON.stringify(off)} is off`)
  }
  assert.equal(designHarnessEnabled({}), false, 'unset is off')
  for (const on of ['1', 'true', 'yes']) {
    assert.equal(designHarnessEnabled({ [ENV]: on }), true, `${on} is on`)
  }
})

test('C1 only the harness variable turns the harness on', () => {
  assert.equal(designHarnessEnabled({ EZDESIGN_NO_UPDATE_CHECK: '1' }), false)
  assert.equal(designHarnessEnabled({ [ENV]: '1', EZDESIGN_NO_UPDATE_CHECK: '0' }), true)
})
