/**
 * R4：持久化失敗必須是「呼叫端可以辨識並處理」的錯誤，不能被 repository 自己吞掉、
 * 只印一行 console.warn 就讓 UI 以為成功了。
 */

export type PersistenceErrorKind = "quota_exceeded" | "unavailable" | "serialize_failed" | "unknown";

export class PersistenceFailedError extends Error {
  readonly kind: PersistenceErrorKind;

  constructor(kind: PersistenceErrorKind, message: string) {
    super(message);
    this.name = "PersistenceFailedError";
    this.kind = kind;
  }
}

/** 給 UI 顯示用的中文錯誤訊息，集中在這裡維護。 */
export function describePersistenceError(error: unknown): string {
  if (error instanceof PersistenceFailedError) {
    switch (error.kind) {
      case "quota_exceeded":
        return "本機儲存空間已滿，這次的變更沒有保存，請清理一些資料或範例項目後再試一次。";
      case "unavailable":
        return "目前無法使用本機儲存（可能是瀏覽器設定封鎖），這次的變更沒有保存。";
      case "serialize_failed":
        return "資料格式異常導致無法保存，這次的變更沒有保存。";
      default:
        return "本機資料寫入失敗，這次的變更沒有保存，請重試一次。";
    }
  }
  return "發生未預期的錯誤，這次的變更沒有保存，請重試一次。";
}
