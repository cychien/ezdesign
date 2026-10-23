import { randomId } from './crypto'
import type { User } from './env'
import { HttpError, nowIso } from './http'

const MAX_EMAIL = 254
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

export function normaliseEmail(raw: string): string | null {
  const email = raw.trim().toLowerCase()
  return email.length <= MAX_EMAIL && EMAIL.test(email) ? email : null
}

export interface UserRow {
  id: string
  email: string
  email_verified: number
  password_hash: string | null
  google_sub: string | null
}

export function findUserByEmail(db: D1Database, email: string): Promise<UserRow | null> {
  return db
    .prepare('select id, email, email_verified, password_hash, google_sub from users where email = ?')
    .bind(email)
    .first<UserRow>()
}

export async function createPasswordUser(
  db: D1Database,
  email: string,
  passwordHash: string,
): Promise<User | 'taken'> {
  const now = nowIso()
  const row = await db
    .prepare(
      `insert into users (id, email, email_verified, password_hash, created_at, updated_at)
       values (?, ?, 0, ?, ?, ?) on conflict (email) do nothing returning id`,
    )
    .bind(randomId(), email, passwordHash, now, now)
    .first<{ id: string }>()
  return row ? { id: row.id, email } : 'taken'
}

async function linkGoogle(db: D1Database, userId: string, sub: string): Promise<void> {
  await db
    .prepare('update users set google_sub = ?, email_verified = 1, updated_at = ? where id = ?')
    .bind(sub, nowIso(), userId)
    .run()
}

async function takeOverUnverifiedAccount(db: D1Database, userId: string, sub: string): Promise<void> {
  const now = nowIso()
  await db.batch([
    db
      .prepare('update users set google_sub = ?, email_verified = 1, password_hash = null, updated_at = ? where id = ?')
      .bind(sub, now, userId),
    db.prepare('update sessions set revoked_at = ? where user_id = ? and revoked_at is null').bind(now, userId),
  ])
}

export async function googleUser(db: D1Database, profile: { sub: string; email: string }): Promise<User> {
  const linked = await db.prepare('select id, email from users where google_sub = ?').bind(profile.sub).first<User>()
  if (linked) return linked

  const existing = await findUserByEmail(db, profile.email)
  if (existing) {
    if (existing.google_sub) throw new HttpError(409, 'email linked to another Google account')
    if (existing.email_verified) await linkGoogle(db, existing.id, profile.sub)
    else await takeOverUnverifiedAccount(db, existing.id, profile.sub)
    return { id: existing.id, email: existing.email }
  }

  const now = nowIso()
  const id = randomId()
  await db
    .prepare(
      `insert into users (id, email, email_verified, google_sub, created_at, updated_at)
       values (?, ?, 1, ?, ?, ?)`,
    )
    .bind(id, profile.email, profile.sub, now, now)
    .run()
  return { id, email: profile.email }
}
