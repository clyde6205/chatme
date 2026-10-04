/**
 * Tracks fire-and-forget work started by request handlers (work that must not
 * affect response timing, such as password-reset lookups) so shutdown and
 * tests can wait for it instead of losing it.
 */
export class BackgroundTasks {
  private readonly pending = new Set<Promise<unknown>>();

  constructor(private readonly onError: (err: unknown, label: string) => void) {}

  run(label: string, fn: () => Promise<unknown>): void {
    const p = Promise.resolve()
      .then(fn)
      .catch((err) => this.onError(err, label))
      .finally(() => this.pending.delete(p));
    this.pending.add(p);
  }

  async idle(): Promise<void> {
    while (this.pending.size) await Promise.allSettled([...this.pending]);
  }

  get size() {
    return this.pending.size;
  }
}
