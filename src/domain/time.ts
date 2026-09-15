/** 時間工具函式，集中處理 ISO 字串與日期運算，避免各處各自 new Date() 造成不一致。 */

export function nowIso(): string {
  return new Date().toISOString();
}

export function addDays(date: Date, days: number): Date {
  const next = new Date(date.getTime());
  next.setDate(next.getDate() + days);
  return next;
}

export function isDueBy(dueAtIso: string, referenceIso: string): boolean {
  return new Date(dueAtIso).getTime() <= new Date(referenceIso).getTime();
}

/** referenceIso 與 targetIso 相差幾個完整天數（無條件進位），用於「幾天後到期」顯示 */
export function daysBetween(referenceIso: string, targetIso: string): number {
  const msPerDay = 24 * 60 * 60 * 1000;
  const diff = new Date(targetIso).getTime() - new Date(referenceIso).getTime();
  return Math.ceil(diff / msPerDay);
}

export function formatDurationMs(totalMs: number): string {
  const totalSeconds = Math.max(0, Math.round(totalMs / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes === 0) return `${seconds} 秒`;
  return `${minutes} 分 ${seconds.toString().padStart(2, "0")} 秒`;
}
