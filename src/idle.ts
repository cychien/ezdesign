/** How long the daemon has gone unused, counted in checks it was awake for.
 *  Wall-clock time counts a laptop's sleep: one that slept past the limit wakes
 *  while its open shells are still reconnecting, and the daemon exits under them. */
export class IdleCount {
  private quiet = 0

  constructor(private readonly limit: number) {}

  /** True once `limit` checks in a row found nothing in use. */
  observe(busy: boolean): boolean {
    this.quiet = busy ? 0 : this.quiet + 1
    return this.quiet >= this.limit
  }
}
