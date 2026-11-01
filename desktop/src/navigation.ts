import { ACCOUNT_LOGIN_PATH } from '../../src/desktop-wire.js'

export type NavigationVerdict =
  | { kind: 'allow' }
  | { kind: 'home' }
  | { kind: 'external'; url: string }
  | { kind: 'deny' }

export interface KnownOrigins {
  home: string
  isSession(origin: string): boolean
}

const EXTERNAL = new Set(['http:', 'https:', 'mailto:'])

export function judgeNavigation(from: string, to: string, known: KnownOrigins): NavigationVerdict {
  const target = URL.parse(to)
  if (!target) return { kind: 'deny' }
  if (target.origin === URL.parse(from)?.origin) return { kind: 'allow' }
  return judgeElsewhere(target, known)
}

export function judgeWindowOpen(url: string, known: KnownOrigins): NavigationVerdict {
  const target = URL.parse(url)
  return target ? judgeElsewhere(target, known) : { kind: 'deny' }
}

function judgeElsewhere(target: URL, known: KnownOrigins): NavigationVerdict {
  const ours = target.origin === known.home || known.isSession(target.origin)
  if (ours && target.pathname === ACCOUNT_LOGIN_PATH) return { kind: 'external', url: target.href }
  if (target.origin === known.home) return { kind: 'home' }
  if (known.isSession(target.origin)) return { kind: 'deny' }
  return EXTERNAL.has(target.protocol) ? { kind: 'external', url: target.href } : { kind: 'deny' }
}
