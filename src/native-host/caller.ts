import { ALLOWED_ORIGINS } from '../capture-wire.js'

export type CallerCheck = { ok: true; origin: string } | { ok: false; reason: string }

/** Chrome passes the caller's origin as the host's first argument, which is
 *  `argv[2]` after node and the script (Windows appends `--parent-window=`
 *  after it). */
export function checkCaller(argv: readonly string[], allowed: readonly string[] = ALLOWED_ORIGINS): CallerCheck {
  const origin = argv[2]
  if (!origin) return { ok: false, reason: 'started without a caller origin; Chrome launches this host' }
  if (!allowed.includes(origin)) return { ok: false, reason: `caller ${origin} is not an allowed origin` }
  return { ok: true, origin }
}
