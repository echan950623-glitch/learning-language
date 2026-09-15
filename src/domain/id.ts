/** 產生穩定唯一 id；優先用 crypto.randomUUID，不可用時退回時間戳＋亂數，確保任何環境都不會拋錯。 */
export function generateId(prefix: string): string {
  const cryptoObj: Crypto | undefined =
    typeof globalThis !== "undefined" && "crypto" in globalThis
      ? (globalThis.crypto as Crypto)
      : undefined;

  if (cryptoObj && typeof cryptoObj.randomUUID === "function") {
    return `${prefix}_${cryptoObj.randomUUID()}`;
  }

  const random = Math.random().toString(36).slice(2, 10);
  return `${prefix}_${Date.now().toString(36)}_${random}`;
}
