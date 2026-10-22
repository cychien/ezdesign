export type HostState =
  | { type: 'connecting' }
  | { type: 'ready'; version: string; node: string; libraryDir: string }
  | { type: 'missing'; installCommand: string }
  | { type: 'incompatible'; older: 'host' | 'extension'; installCommand: string }
  | { type: 'broken'; message: string }

export type WorkerRequest = { to: 'worker'; type: 'host-status'; recheck: boolean }
