/**
 * 登入頁與 callback route 共用的固定錯誤代碼。
 *
 * callback route 一律只把這組固定代碼放進導回登入頁的網址（`?error=...`），不會把
 * Supabase／Google 回傳的原始 error/error_description 文字直接顯示給使用者或存進
 * 網址——避免外洩內部細節，也避免任意文字被塞進 UI。
 */

export const AUTH_ERROR_CODES = [
  "oauth_denied",
  "oauth_missing_code",
  "oauth_exchange_failed",
  "provider_unavailable",
] as const;

export type AuthErrorCode = (typeof AUTH_ERROR_CODES)[number];

const AUTH_ERROR_MESSAGES: Record<AuthErrorCode, string> = {
  oauth_denied: "Google 登入已取消或被拒絕，請重新嘗試，或改用下方 Email 登入連結。",
  oauth_missing_code: "Google 登入回應不完整，請重新嘗試，或改用下方 Email 登入連結。",
  oauth_exchange_failed: "Google 登入驗證失敗，請重新嘗試，或改用下方 Email 登入連結。",
  provider_unavailable: "Google 登入目前尚未啟用，請改用下方 Email 登入連結。",
};

function isAuthErrorCode(value: string): value is AuthErrorCode {
  return (AUTH_ERROR_CODES as readonly string[]).includes(value);
}

/** 未知或缺漏的代碼一律回傳 null（畫面上不顯示任何錯誤），不會把任意字串顯示出來。 */
export function resolveAuthErrorMessage(code: string | null | undefined): string | null {
  if (!code) return null;
  if (!isAuthErrorCode(code)) return null;
  return AUTH_ERROR_MESSAGES[code];
}
