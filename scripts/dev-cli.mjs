import { runCli } from './dev-env.mjs'

/** `ezdesign` pointed at the dev daemon instead of the real one. */
await runCli(process.argv.slice(2))
