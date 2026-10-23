import assert from 'node:assert/strict'
import { test } from 'node:test'
import { DEFAULT_CONTROL_PORT, FETCH_BAD_PORTS, controlPortRange, resolveControlPort } from '../src/constants.js'

test('falls back to the default when unset', () => {
  assert.equal(resolveControlPort(undefined), DEFAULT_CONTROL_PORT)
  assert.equal(resolveControlPort(''), DEFAULT_CONTROL_PORT)
})

test('accepts a usable port', () => {
  assert.equal(resolveControlPort('4410'), 4410)
})

// A set value is deliberate, so one that cannot be used has to be fatal, not
// quietly swapped for the default range.
test('throws on values that cannot make a bindable range', () => {
  for (const raw of ['abc', '80', '0', '-1', '65530', '4410.5', 'Infinity']) {
    assert.throws(() => resolveControlPort(raw), /CONTROL_PORT/, raw)
  }
})

test("a range never offers a port Node's fetch refuses", async () => {
  const before = process.env.EZDESIGN_CONTROL_PORT
  process.env.EZDESIGN_CONTROL_PORT = '4190'
  try {
    assert.deepEqual(controlPortRange().ports, [4191, 4192, 4193, 4194, 4195, 4196, 4197, 4198, 4199])
  } finally {
    if (before === undefined) delete process.env.EZDESIGN_CONTROL_PORT
    else process.env.EZDESIGN_CONTROL_PORT = before
  }
  for (const port of [...FETCH_BAD_PORTS].filter((p) => p >= 1024)) {
    const refused = await fetch(`http://127.0.0.1:${port}/`).then(
      () => null,
      (error: Error & { cause?: Error }) => error.cause?.message ?? null,
    )
    assert.equal(refused, 'bad port', `node's fetch on ${port}`)
  }
})
