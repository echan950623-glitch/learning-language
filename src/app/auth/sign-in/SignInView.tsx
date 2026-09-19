"use client";

import { useState, type FormEvent } from "react";

import { createBrowserClient } from "@/lib/supabase/client";
import { buildAuthCallbackUrl } from "@/lib/auth/safeRedirect";
import { startGoogleSignIn } from "@/lib/auth/googleSignIn";

type SendStatus = "idle" | "sending" | "sent" | "error";
type GoogleStatus = "idle" | "starting" | "error";

interface SignInViewProps {
  /** 已經過 `resolveSafeRedirect()` 驗證的站內路徑，登入成功後導去這裡。 */
  redirectTo: string;
  /** 伺服器端 no-store 查詢過的即時結果；false 時 Google 按鈕必須停用，不能顯示成可點。 */
  googleAvailable: boolean;
  /** 由固定錯誤代碼轉換出的訊息；未知／缺漏代碼一律是 null，不顯示任何內容。 */
  errorMessage: string | null;
}

function GoogleMark() {
  return (
    <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true" className="shrink-0">
      <path
        fill="#4285F4"
        d="M17.64 9.2c0-.64-.06-1.25-.16-1.84H9v3.48h4.84c-.21 1.13-.85 2.09-1.8 2.73v2.27h2.92c1.71-1.57 2.68-3.88 2.68-6.64z"
      />
      <path
        fill="#34A853"
        d="M9 18c2.43 0 4.47-.8 5.96-2.18l-2.92-2.27c-.81.54-1.84.86-3.04.86-2.34 0-4.32-1.58-5.03-3.71H.96v2.34C2.44 15.98 5.48 18 9 18z"
      />
      <path
        fill="#FBBC05"
        d="M3.97 10.7A5.4 5.4 0 0 1 3.68 9c0-.59.1-1.17.29-1.7V4.96H.96A9 9 0 0 0 0 9c0 1.45.35 2.83.96 4.04z"
      />
      <path
        fill="#EA4335"
        d="M9 3.58c1.32 0 2.5.45 3.44 1.35l2.58-2.58C13.46.89 11.43 0 9 0 5.48 0 2.44 2.02.96 4.96l3.01 2.34C4.68 5.16 6.66 3.58 9 3.58z"
      />
    </svg>
  );
}

export function SignInView({ redirectTo, googleAvailable, errorMessage }: SignInViewProps) {
  const [email, setEmail] = useState("");
  const [status, setStatus] = useState<SendStatus>("idle");
  const [emailError, setEmailError] = useState<string | null>(null);

  const [googleStatus, setGoogleStatus] = useState<GoogleStatus>("idle");
  const [googleError, setGoogleError] = useState<string | null>(null);

  async function handleSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    const trimmedEmail = email.trim();
    if (!trimmedEmail) return;

    setStatus("sending");
    setEmailError(null);
    try {
      const supabase = createBrowserClient();
      const { error } = await supabase.auth.signInWithOtp({
        email: trimmedEmail,
        options: { emailRedirectTo: buildAuthCallbackUrl(window.location.origin, redirectTo) },
      });
      if (error) throw error;

      setStatus("sent");
    } catch {
      console.error("【登入】寄送登入連結失敗:", {
        category: "email_sign_in_failed",
        timestamp: new Date().toISOString(),
      });
      setStatus("error");
      setEmailError("寄送登入連結失敗，請確認 Email 是否正確，或稍後再試一次。");
    }
  }

  async function handleGoogleSignIn(): Promise<void> {
    if (!googleAvailable || googleStatus === "starting") return;

    setGoogleStatus("starting");
    setGoogleError(null);
    try {
      const supabase = createBrowserClient();
      const { error } = await startGoogleSignIn(
        supabase,
        buildAuthCallbackUrl(window.location.origin, redirectTo)
      );
      if (error) {
        setGoogleStatus("error");
        setGoogleError(error);
        return;
      }
      // 成功時 signInWithOAuth 會讓瀏覽器整頁導去 Google 的帳戶選擇畫面，這裡不需要再處理狀態。
    } catch {
      console.error("【登入】啟動 Google 登入時發生未預期例外:", {
        category: "google_sign_in_failed",
        timestamp: new Date().toISOString(),
      });
      setGoogleStatus("error");
      setGoogleError("無法啟動 Google 登入，請稍後再試，或改用下方 Email 登入連結。");
    }
  }

  return (
    <main className="mx-auto flex w-[94%] max-w-sm flex-1 flex-col justify-center gap-5 py-6">
      <header>
        <h1 className="text-xl font-semibold text-foreground">登入</h1>
        <p className="mt-1 text-sm text-foreground-muted">
          登入後，這台裝置的學習紀錄可以同步到雲端，也能讓已連結的 GPT 讀取你的學習進度。
        </p>
      </header>

      {errorMessage ? (
        <p role="alert" className="rounded-2xl border border-danger bg-danger-bg px-4 py-3 text-sm text-danger">
          {errorMessage}
        </p>
      ) : null}

      <section className="flex flex-col gap-2">
        <button
          type="button"
          onClick={handleGoogleSignIn}
          disabled={!googleAvailable || googleStatus === "starting"}
          className="flex min-h-12 items-center justify-center gap-2 rounded-xl border border-border bg-surface px-4 py-3 text-sm font-semibold text-foreground transition-colors hover:bg-surface-muted disabled:cursor-not-allowed disabled:opacity-50"
        >
          <GoogleMark />
          {googleStatus === "starting" ? "正在前往 Google…" : "使用 Google 登入"}
        </button>

        <p role="status" className="text-xs leading-5 text-foreground-muted">
          {googleAvailable
            ? "請選擇與你連結 GPT 時相同的 Google 帳戶／Email，雲端資料才會對上同一個帳號。"
            : "Google 登入目前尚未啟用，請先使用下方 Email 登入連結；等正式開放後這裡會改成可以點擊。"}
        </p>

        {googleStatus === "error" && googleError ? (
          <p role="alert" className="text-xs text-danger">
            {googleError}
          </p>
        ) : null}
      </section>

      <div className="flex items-center gap-3 text-xs text-foreground-muted" aria-hidden="true">
        <span className="h-px flex-1 bg-border" />
        或
        <span className="h-px flex-1 bg-border" />
      </div>

      {status === "sent" ? (
        <div role="status" className="rounded-2xl border border-border bg-surface p-4 text-sm text-foreground">
          登入連結已寄出，請到 <span className="font-medium">{email.trim()}</span> 收信並點擊連結完成登入。
        </div>
      ) : (
        <form onSubmit={handleSubmit} className="flex flex-col gap-3">
          <label className="flex flex-col gap-1 text-sm font-medium text-foreground">
            Email
            <input
              type="email"
              required
              autoComplete="email"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              placeholder="you@example.com"
              className="rounded-xl border border-border bg-surface px-4 py-3 text-sm text-foreground outline-none focus:border-primary"
            />
          </label>

          <button
            type="submit"
            disabled={status === "sending" || email.trim().length === 0}
            className="rounded-xl bg-primary px-4 py-3 text-center text-sm font-semibold text-primary-foreground transition-colors hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {status === "sending" ? "寄送中…" : "寄送登入連結"}
          </button>

          {status === "error" && emailError ? (
            <p role="alert" className="text-xs text-danger">
              {emailError}
            </p>
          ) : null}
        </form>
      )}
    </main>
  );
}
