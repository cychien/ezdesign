/** Mode 600 on every write: the file holds bearer tokens in plain text. */

import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { DATA_DIR } from './constants.js'

export interface AccountCredential {
  token: string
  user: { id: string; email: string }
}

export interface Credentials {
  inspire?: { token: string }
  account?: AccountCredential
}

export const CREDENTIALS_MODE = 0o600

export function credentialsFile(dataDir: string = DATA_DIR): string {
  return join(dataDir, 'credentials.json')
}

/** Missing, unreadable or malformed all mean no credentials. */
export function readCredentials(file: string = credentialsFile()): Credentials {
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as unknown
    if (!parsed || typeof parsed !== 'object') return {}
    return parsed as Credentials
  } catch {
    return {}
  }
}

export function writeCredentials(creds: Credentials, file: string = credentialsFile()): void {
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, `${JSON.stringify(creds, null, 2)}\n`, { mode: CREDENTIALS_MODE })
  chmodSync(file, CREDENTIALS_MODE)
}

export function readInspireToken(file: string = credentialsFile()): string | null {
  const token = readCredentials(file).inspire?.token
  return typeof token === 'string' && token.trim() !== '' ? token.trim() : null
}

export function writeInspireToken(token: string, file: string = credentialsFile()): void {
  writeCredentials({ ...readCredentials(file), inspire: { token } }, file)
}

export function clearInspireToken(file: string = credentialsFile()): boolean {
  return forget('inspire', file)
}

export function readAccount(file: string = credentialsFile()): AccountCredential | null {
  const account = readCredentials(file).account
  const ok =
    typeof account?.token === 'string' &&
    account.token !== '' &&
    typeof account.user?.id === 'string' &&
    typeof account.user.email === 'string'
  return ok ? { token: account.token, user: { id: account.user.id, email: account.user.email } } : null
}

export function writeAccount(account: AccountCredential, file: string = credentialsFile()): void {
  writeCredentials({ ...readCredentials(file), account }, file)
}

export function clearAccount(file: string = credentialsFile()): boolean {
  return forget('account', file)
}

function forget(key: keyof Credentials, file: string): boolean {
  const creds = readCredentials(file)
  const had = creds[key] !== undefined
  delete creds[key]
  if (Object.keys(creds).length === 0) rmSync(file, { force: true })
  else writeCredentials(creds, file)
  return had
}
