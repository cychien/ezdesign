import assert from 'node:assert/strict'
import { test } from 'node:test'
import { DRAWER_DEFAULT, DRAWER_MAX, DRAWER_MIN, clampDrawerWidth, maxDrawerWidth } from '../src/client/drawer-width.js'
import { STAGE_MIN } from '../src/client/sidebar-width.js'

const ROOMY = DRAWER_MAX + STAGE_MIN + 200

test('the drawer’s default sits inside the range it is clamped to', () => {
  assert.equal(clampDrawerWidth(DRAWER_DEFAULT, ROOMY), DRAWER_DEFAULT)
  assert.equal(clampDrawerWidth(9999, ROOMY), DRAWER_MAX)
  assert.equal(clampDrawerWidth(0, ROOMY), DRAWER_MIN)
})

test('the page keeps its floor beside the drawer until the drawer would go under its own', () => {
  assert.equal(maxDrawerWidth(DRAWER_MAX + STAGE_MIN), DRAWER_MAX)
  assert.equal(maxDrawerWidth(DRAWER_MAX + STAGE_MIN - 100), DRAWER_MAX - 100)
  assert.equal(maxDrawerWidth(DRAWER_MIN + STAGE_MIN - 100), DRAWER_MIN)
  assert.equal(clampDrawerWidth(500, DRAWER_MIN + STAGE_MIN + 40), DRAWER_MIN + 40)
})
