import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { ProjectBook, mergeProjects } from '../src/projects/book.js'

const file = () => join(mkdtempSync(join(tmpdir(), 'ezdesign-book-')), 'projects.json')

test('sessions and added folders, most recently used first', () => {
  const book = new ProjectBook(
    [
      { project: '/code/old', createdAt: 100 },
      { project: '/code/cli-opened', createdAt: 200 },
    ],
    file(),
  )
  book.add('/code/added', 300)
  book.markUsed('/code/cli-opened', 400)
  assert.deepEqual(
    book.list().map((p) => [p.project, p.name, p.usedAt]),
    [
      ['/code/cli-opened', 'cli-opened', 400],
      ['/code/added', 'added', 300],
      ['/code/old', 'old', 100],
    ],
  )
})

test('hidden until opened or added again, with nothing cleared', () => {
  const path = file()
  const book = new ProjectBook([{ project: '/code/a', createdAt: 1 }], path)
  book.hide('/code/a', 10)
  assert.deepEqual(book.list(), [])
  assert.equal(book.isListed('/code/a'), true, 'a stale tab may still open it')
  book.markUsed('/code/a', 20)
  assert.deepEqual(book.list().map((p) => p.project), ['/code/a'])
  book.hide('/code/a', 30)
  book.add('/code/a', 40)
  assert.deepEqual(book.list().map((p) => p.project), ['/code/a'])
  assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')), {
    version: 1,
    projects: { '/code/a': { usedAt: 20, hiddenAt: 30, addedAt: 40 } },
  })
})

test('a project nobody chose cannot be hidden into the book or opened', () => {
  const book = new ProjectBook([], file())
  book.hide('/etc', 5)
  assert.equal(book.isListed('/etc'), false)
})

test('a folder that is gone stays listed, marked', () => {
  const rows = mergeProjects(new Map([['/gone', { addedAt: 5 }]]), new Map([['/here', { createdAt: 4 }]]), (p) => p === '/here')
  assert.deepEqual(rows, [
    { project: '/gone', name: 'gone', usedAt: 5, exists: false },
    { project: '/here', name: 'here', usedAt: 4, exists: true },
  ])
})

test('the book survives a restart', () => {
  const path = file()
  new ProjectBook([], path).add('/code/kept', 7)
  assert.deepEqual(new ProjectBook([], path).list().map((p) => p.project), ['/code/kept'])
})
