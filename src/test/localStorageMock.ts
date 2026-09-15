/**
 * 最小可用的 localStorage polyfill，只供測試用。
 * Vitest 在 Node 環境執行時沒有真正的瀏覽器 storage，
 * 但 LocalStorageLearningRepository 需要 window.localStorage 才能測試持久化與壞資料 fallback，
 * 所以用這個輕量 in-memory 版本掛到 globalThis，不用額外引入 jsdom 依賴。
 *
 * `failNextSetItem` / `failSetItemAlways`：R4 需要測試「localStorage.setItem 失敗」時
 * repository 是否正確 rollback、不會顯示假成功，這裡提供可控的失敗開關。
 */
export class MemoryStorage implements Storage {
  private map = new Map<string, string>();
  private failNext = 0;
  private failAlways = false;
  private failureFactory: () => Error = () => {
    const error = new DOMException("The quota has been exceeded.", "QuotaExceededError");
    return error;
  };

  get length(): number {
    return this.map.size;
  }

  clear(): void {
    this.map.clear();
  }

  getItem(key: string): string | null {
    return this.map.has(key) ? this.map.get(key)! : null;
  }

  key(index: number): string | null {
    return Array.from(this.map.keys())[index] ?? null;
  }

  removeItem(key: string): void {
    this.map.delete(key);
  }

  setItem(key: string, value: string): void {
    if (this.failAlways || this.failNext > 0) {
      if (this.failNext > 0) this.failNext -= 1;
      throw this.failureFactory();
    }
    this.map.set(key, String(value));
  }

  /** 接下來 N 次 setItem 都會丟出設定好的錯誤（預設是 QuotaExceededError）。 */
  failNextSetItem(times = 1, factory?: () => Error): void {
    this.failNext = times;
    if (factory) this.failureFactory = factory;
  }

  /** 之後所有 setItem 都失敗，直到呼叫 stopFailing()。 */
  failSetItemAlways(factory?: () => Error): void {
    this.failAlways = true;
    if (factory) this.failureFactory = factory;
  }

  stopFailing(): void {
    this.failAlways = false;
    this.failNext = 0;
  }
}

export function installMockLocalStorage(): MemoryStorage {
  const storage = new MemoryStorage();
  Object.defineProperty(globalThis, "window", {
    value: globalThis,
    writable: true,
    configurable: true,
  });
  Object.defineProperty(globalThis, "localStorage", {
    value: storage,
    writable: true,
    configurable: true,
  });
  return storage;
}
