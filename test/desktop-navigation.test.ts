import assert from 'node:assert/strict'
import { test } from 'node:test'
import { judgeNavigation, judgeWindowOpen } from '../desktop/src/navigation.js'

const known = {
  home: 'http://127.0.0.1:4400',
  isSession: (origin: string) => origin === 'http://127.0.0.1:51000' || origin === 'http://127.0.0.1:52000',
}
const SHELL = 'http://127.0.0.1:51000/__ezdesign/shell'

test('a view moves within its own origin', () => {
  assert.deepEqual(judgeNavigation(SHELL, 'http://127.0.0.1:51000/__ezdesign/shell?path=%2Fpricing', known), { kind: 'allow' })
})

test('the home origin shows the home view instead', () => {
  assert.deepEqual(judgeNavigation(SHELL, 'http://127.0.0.1:4400/__ezdesign/home', known), { kind: 'home' })
})

test("another project's origin is refused: the bridge switches projects", () => {
  assert.deepEqual(judgeNavigation(SHELL, 'http://127.0.0.1:52000/__ezdesign/shell', known), { kind: 'deny' })
})

test('the web, mail links and the user’s dev server opened on its own go to the system browser', () => {
  assert.deepEqual(judgeNavigation(SHELL, 'https://ezdesign.dev/docs', known), { kind: 'external', url: 'https://ezdesign.dev/docs' })
  assert.deepEqual(judgeNavigation(SHELL, 'mailto:hi@example.com', known), { kind: 'external', url: 'mailto:hi@example.com' })
  assert.deepEqual(judgeNavigation(SHELL, 'http://localhost:5173/', known), { kind: 'external', url: 'http://localhost:5173/' })
})

test('anything else is refused', () => {
  for (const url of ['file:///etc/passwd', 'javascript:alert(1)', 'data:text/html,hi', 'not a url']) {
    assert.deepEqual(judgeNavigation(SHELL, url, known), { kind: 'deny' }, url)
  }
})

test('window.open never opens a window of ours', () => {
  assert.deepEqual(judgeWindowOpen('https://accounts.google.com/o/oauth2', known), {
    kind: 'external',
    url: 'https://accounts.google.com/o/oauth2',
  })
  assert.deepEqual(judgeWindowOpen('http://127.0.0.1:4400/__ezdesign/home', known), { kind: 'home' })
  assert.deepEqual(judgeWindowOpen('http://127.0.0.1:52000/', known), { kind: 'deny' })
  assert.deepEqual(judgeWindowOpen('file:///Users', known), { kind: 'deny' })
})
