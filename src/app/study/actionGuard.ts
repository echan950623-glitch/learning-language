/** Keep delayed clicks on the previous card from acting on the next card. */
export class StudyActionGuard {
  private pending = false;
  private completedKey: string | null = null;
  private blockedUntil = -Infinity;

  begin(key: string, eventTime: number, now: number): boolean {
    // Older WebKit events can use epoch milliseconds instead of performance time.
    const timestamp = eventTime > 1e12 ? eventTime - performance.timeOrigin : eventTime;
    if (this.pending || key === this.completedKey || timestamp <= this.blockedUntil) return false;
    this.pending = true;
    // Also reject input already queued before this operation began.
    this.blockedUntil = now;
    return true;
  }

  finish(key: string, succeeded: boolean, now: number): void {
    this.pending = false;
    if (succeeded) {
      this.completedKey = key;
      this.blockedUntil = now + 400;
    }
  }
}
