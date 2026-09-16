"use client";

import { Suspense, useState, type FormEvent } from "react";
import { useSearchParams } from "next/navigation";

import { createBrowserClient } from "@/lib/supabase/client";

type SendStatus = "idle" | "sending" | "sent" | "error";

function SignInForm() {
  const searchParams = useSearchParams();
  const redirectParam = searchParams.get("redirect");
  // 只接受站內相對路徑，避免被拿來當開放重導向使用。
  const redirectTo = redirectParam && redirectParam.startsWith("/") && !redirectParam.startsWith("//") ? redirectParam : "/";

  const [email, setEmail] = useState("");
  const [status, setStatus] = useState<SendStatus>("idle");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  async function handleSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    const trimmedEmail = email.trim();
    if (!trimmedEmail) return;

    setStatus("sending");
    setErrorMessage(null);
    try {
      const supabase = createBrowserClient();
      const callbackUrl = new URL("/auth/callback", window.location.origin);
      callbackUrl.searchParams.set("redirect", redirectTo);

      const { error } = await supabase.auth.signInWithOtp({
        email: trimmedEmail,
        options: { emailRedirectTo: callbackUrl.toString() },
      });
      if (error) throw error;

      setStatus("sent");
    } catch (error) {
      console.error("【登入】寄送登入連結失敗:", {
        message: error instanceof Error ? error.message : String(error),
        timestamp: new Date().toISOString(),
      });
      setStatus("error");
      setErrorMessage("寄送登入連結失敗，請確認 Email 是否正確，或稍後再試一次。");
    }
  }

  return (
    <main className="mx-auto flex w-[94%] max-w-sm flex-1 flex-col justify-center gap-5 py-6">
      <header>
        <h1 className="text-xl font-semibold text-foreground">登入</h1>
        <p className="mt-1 text-sm text-foreground-muted">
          輸入 Email，我們會寄送一次性登入連結。登入後，這台裝置的學習紀錄可以同步到雲端。
        </p>
      </header>

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

          {status === "error" && errorMessage ? (
            <p role="alert" className="text-xs text-danger">
              {errorMessage}
            </p>
          ) : null}
        </form>
      )}
    </main>
  );
}

export default function SignInPage() {
  return (
    <Suspense fallback={null}>
      <SignInForm />
    </Suspense>
  );
}
