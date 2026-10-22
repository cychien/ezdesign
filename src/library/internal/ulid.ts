import { randomBytes } from 'node:crypto'

const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'
const RANDOM_MAX = (1n << 80n) - 1n

let lastTime = -1
let lastRandom = 0n

function encode(value: bigint, length: number): string {
  let out = ''
  for (let i = 0; i < length; i++) {
    out = ALPHABET[Number(value & 31n)] + out
    value >>= 5n
  }
  return out
}

export function ulid(now: number = Date.now()): string {
  if (now <= lastTime && lastRandom < RANDOM_MAX) {
    lastRandom += 1n
  } else {
    lastTime = Math.max(now, lastTime)
    lastRandom = BigInt(`0x${randomBytes(10).toString('hex')}`) >> 1n
  }
  return encode(BigInt(lastTime), 10) + encode(lastRandom, 16)
}
