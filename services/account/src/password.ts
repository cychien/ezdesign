import { base64url, constantTimeEqual, fromBase64url } from './crypto'

const SCHEME = 'pbkdf2-sha256'
/** Workers refuse PBKDF2 above this many iterations. */
const ITERATIONS = 100_000
const encoder = new TextEncoder()

export const MIN_PASSWORD = 8
export const MAX_PASSWORD = 128

async function derive(password: string, salt: Uint8Array, iterations: number): Promise<string> {
  const key = await crypto.subtle.importKey('raw', encoder.encode(password), 'PBKDF2', false, ['deriveBits'])
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, key, 256)
  return base64url(new Uint8Array(bits))
}

export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16))
  return `${SCHEME}$${ITERATIONS}$${base64url(salt)}$${await derive(password, salt, ITERATIONS)}`
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [scheme, iterations, salt, hash] = stored.split('$')
  if (scheme !== SCHEME || !iterations || !salt || !hash) return false
  return constantTimeEqual(await derive(password, fromBase64url(salt), Number(iterations)), hash)
}
