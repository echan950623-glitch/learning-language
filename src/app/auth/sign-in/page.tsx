/**
 * 登入頁：Server Component，負責在伺服器端把三件會影響「畫面該顯示什麼」的事情算好，
 * 再把結果當 prop 交給純互動用的 `SignInView`（Client Component）：
 * 1. 用 `resolveSafeRedirect()` 驗證 `redirect` query，防止開放重導向。
 * 2. 用 `resolveAuthErrorMessage()` 把 callback route 傳回來的固定錯誤代碼轉成文案。
 * 3. 伺服器端、no-store 查詢 Google OAuth provider 是否真的已啟用——刻意不做成
 *    Client Component 掛載後才 fetch 的「先顯示、後確認」流程，避免出現一段按鈕
 *    看起來可以點、但 provider 其實還沒開的空窗期。
 */
import { SignInView } from "./SignInView";
import { resolveSafeRedirect } from "@/lib/auth/safeRedirect";
import { resolveAuthErrorMessage } from "@/lib/auth/errorCodes";
import { isGoogleOAuthProviderAvailable } from "@/lib/auth/googleProviderAvailability";

interface SignInPageProps {
  searchParams: Promise<{ redirect?: string; error?: string }>;
}

export default async function SignInPage({ searchParams }: SignInPageProps) {
  const { redirect: redirectParam, error: errorParam } = await searchParams;

  const redirectTo = resolveSafeRedirect(redirectParam);
  const errorMessage = resolveAuthErrorMessage(errorParam);
  const googleAvailable = await isGoogleOAuthProviderAvailable();

  return <SignInView redirectTo={redirectTo} googleAvailable={googleAvailable} errorMessage={errorMessage} />;
}
