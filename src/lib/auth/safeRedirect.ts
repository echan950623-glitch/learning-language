/**
 * 登入頁與 callback route 共用的安全重導向驗證。
 *
 * 不能只用字串前綴比對（例如 `value.startsWith("/") && !value.startsWith("//")`）：
 * WHATWG URL 解析對「特殊 scheme」（http/https 等）會把反斜線視同正斜線處理，
 * 所以 `/\evil.com` 這種字串不會被上述前綴檢查擋下，但實際解析出來的 host 會變成
 * `evil.com`（等同 `//evil.com` 開放重導向）。這裡改用 `new URL()` 對固定的哨兵
 * origin 解析一次、比對解析後的 origin 是否還是原本的哨兵值，才是真正的
 * canonicalization 檢查；額外的反斜線／控制字元前置檢查則是不依賴 URL parser
 * 特定實作細節的獨立防線。
 */

export const DEFAULT_REDIRECT_PATH = "/settings";

const SENTINEL_ORIGIN = "http://sentinel.invalid";

function hasControlCharacter(value: string): boolean {
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

/**
 * 驗證使用者可控的重導向目標。只接受「同源、單一前導斜線、不含反斜線／控制字元」的
 * 站內路徑（可帶 query string／hash）；其餘一律回傳 `fallback`（預設 `/settings`），
 * 不拋出例外。
 */
export function resolveSafeRedirect(
  value: string | null | undefined,
  fallback: string = DEFAULT_REDIRECT_PATH
): string {
  if (!value) return fallback;
  if (hasControlCharacter(value)) return fallback;
  if (value.includes("\\")) return fallback;
  if (!value.startsWith("/") || value.startsWith("//")) return fallback;

  try {
    const resolved = new URL(value, SENTINEL_ORIGIN);
    if (resolved.origin !== SENTINEL_ORIGIN) return fallback;

    const canonical = `${resolved.pathname}${resolved.search}${resolved.hash}`;
    if (!canonical.startsWith("/") || canonical.startsWith("//")) return fallback;
    return canonical;
  } catch {
    return fallback;
  }
}

/** 組出「登入成功後導回這個 origin 的 /auth/callback」，redirect 參數一律先過安全驗證。 */
export function buildAuthCallbackUrl(origin: string, redirectTarget: string | null | undefined): string {
  const url = new URL("/auth/callback", origin);
  url.searchParams.set("redirect", resolveSafeRedirect(redirectTarget));
  return url.toString();
}
