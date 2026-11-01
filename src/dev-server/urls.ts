const ANSI = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-Z\\-_]/g

/** CSI and OSC sequences. Vite colours the port in the middle of its URL
 *  (`http://localhost:\e[1m4471\e[22m/`), so codes come out before matching. */
export function stripAnsi(text: string): string {
  return text.replace(ANSI, '')
}

const URL_IN_TEXT = /\bhttps?:\/\/[^\s'"<>`)]+/g

const LOCAL_HOSTS: Readonly<Record<string, string>> = {
  localhost: 'localhost',
  '127.0.0.1': '127.0.0.1',
  '[::1]': '[::1]',
  '0.0.0.0': 'localhost',
  '[::]': 'localhost',
}

export function localOriginsIn(line: string): string[] {
  const found: string[] = []
  for (const [raw] of stripAnsi(line).matchAll(URL_IN_TEXT)) {
    let url: URL
    try {
      url = new URL(raw.replace(/[.,;:!?\]}]+$/, ''))
    } catch {
      continue
    }
    const host = LOCAL_HOSTS[url.hostname]
    if (!host) continue
    found.push(`${url.protocol}//${host}${url.port ? `:${url.port}` : ''}`)
  }
  return found
}

export class OriginScanner {
  private partial = ''
  private readonly seen: string[] = []

  push(chunk: string): string[] {
    const text = this.partial + chunk
    const parts = text.split(/\r?\n/)
    this.partial = parts.pop() ?? ''
    return parts.map((line) => this.take(line))
  }

  flush(): string[] {
    const rest = this.partial
    this.partial = ''
    return rest ? [this.take(rest)] : []
  }

  get origins(): readonly string[] {
    return this.seen
  }

  private take(line: string): string {
    // A progress line redrawn with `\r` keeps only what is on screen last.
    const visible = stripAnsi(line).split('\r').at(-1) ?? ''
    for (const origin of localOriginsIn(visible)) if (!this.seen.includes(origin)) this.seen.push(origin)
    return visible
  }
}

/** TCP ports in `LISTEN` from `lsof -nP -iTCP -sTCP:LISTEN -a -p <pids> -F pn`
 *  output, deduplicated, lowest first. */
export function parseListeningPorts(lsofOutput: string): number[] {
  const ports = new Set<number>()
  for (const line of lsofOutput.split('\n')) {
    if (!line.startsWith('n')) continue
    const port = Number(line.slice(line.lastIndexOf(':') + 1))
    if (Number.isInteger(port) && port > 0 && port < 65536) ports.add(port)
  }
  return [...ports].sort((a, b) => a - b)
}
