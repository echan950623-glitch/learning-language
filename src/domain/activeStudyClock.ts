/** Foreground time only; slow typing has no effect on grading. */
export class ActiveStudyClock {
  private accumulated = 0;
  private since: number | null = null;
  reset(now: number, visible: boolean): void { this.accumulated = 0; this.since = visible ? now : null; }
  setVisible(now: number, visible: boolean): void {
    if (this.since !== null) this.accumulated += Math.max(0, now - this.since);
    this.since = visible ? now : null;
  }
  elapsed(now: number): number { return Math.round(this.accumulated + (this.since === null ? 0 : Math.max(0, now - this.since))); }
}
