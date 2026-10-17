import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Code under test resolves its data dir from the env at import, falling back to
// the user's real ~/.ezdesign, so the whole run gets a throwaway one instead.
const root = mkdtempSync(join(tmpdir(), 'ezdesign-test-run-'))

const child = spawn(
  process.execPath,
  ['--import', 'tsx', '--test', 'test/**/*.test.ts', ...process.argv.slice(2)],
  {
    stdio: 'inherit',
    env: { ...process.env, EZDESIGN_DATA_DIR: join(root, 'data') },
  },
)

for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal))

child.on('exit', (code, signal) => {
  rmSync(root, { recursive: true, force: true, maxRetries: 3 })
  process.exitCode = code ?? (signal ? 1 : 0)
})
