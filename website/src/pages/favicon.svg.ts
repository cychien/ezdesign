import { brandMarkSvg } from '../../../src/brand'

export function GET(): Response {
  return new Response(brandMarkSvg(), { headers: { 'Content-Type': 'image/svg+xml' } })
}
