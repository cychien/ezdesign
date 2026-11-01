export interface Host {
  readonly kind: 'browser' | 'desktop'
}

export const host: Host = { kind: 'browser' }
