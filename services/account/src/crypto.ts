const encoder = new TextEncoder()

export function base64url(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

export function fromBase64url(text: string): Uint8Array {
  const binary = atob(text.replace(/-/g, '+').replace(/_/g, '/'))
  return Uint8Array.from(binary, (char) => char.charCodeAt(0))
}

export function randomSecret(prefix = ''): string {
  return prefix + base64url(crypto.getRandomValues(new Uint8Array(32)))
}

export function randomId(): string {
  let out = ''
  for (const byte of crypto.getRandomValues(new Uint8Array(16))) out += byte.toString(16).padStart(2, '0')
  return out
}

export async function sha256(input: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(input)))
}

export async function sha256Hex(input: string): Promise<string> {
  let out = ''
  for (const byte of await sha256(input)) out += byte.toString(16).padStart(2, '0')
  return out
}

export async function pkceChallenge(verifier: string): Promise<string> {
  return base64url(await sha256(verifier))
}

export function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}
