/**
 * OAuth 2.1 授權同意頁。比照 Supabase 官方文件「Getting Started with OAuth 2.1 Server」
 * 的 Next.js 範例：Server Component 讀 `authorization_id` → 用讀 cookie 的 Supabase
 * client 確認登入狀態 → `supabase.auth.oauth.getAuthorizationDetails(authorizationId)`
 * 取得同意畫面所需資訊 → 表單送到 `/api/oauth/decision`。
 */
import { redirect } from "next/navigation";

import { createSupabaseServerClient } from "@/lib/supabase/server";

export const runtime = "nodejs";

interface OAuthConsentPageProps {
  searchParams: Promise<{ authorization_id?: string }>;
}

function InfoCard({ title, message }: { title: string; message: string }) {
  return (
    <main className="mx-auto flex w-[94%] max-w-md flex-1 flex-col items-center justify-center gap-3 py-16 text-center">
      <h1 className="text-lg font-semibold text-foreground">{title}</h1>
      <p className="text-sm text-foreground-muted">{message}</p>
    </main>
  );
}

export default async function OAuthConsentPage({ searchParams }: OAuthConsentPageProps) {
  const { authorization_id: authorizationId } = await searchParams;

  if (!authorizationId) {
    return <InfoCard title="授權請求無效" message="缺少 authorization_id 參數，請從發起授權的應用程式重新開始。" />;
  }

  const supabase = await createSupabaseServerClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    const redirectTarget = `/oauth/consent?authorization_id=${encodeURIComponent(authorizationId)}`;
    redirect(`/auth/sign-in?redirect=${encodeURIComponent(redirectTarget)}`);
  }

  let details;
  try {
    const { data, error } = await supabase.auth.oauth.getAuthorizationDetails(authorizationId);
    if (error) throw error;
    details = data;
  } catch (error) {
    console.error("【OAuth 授權同意頁】讀取授權詳情失敗:", {
      message: error instanceof Error ? error.message : String(error),
      timestamp: new Date().toISOString(),
    });
    return <InfoCard title="授權請求已失效" message="這個授權請求可能已經過期或已被處理過，請從發起授權的應用程式重新開始。" />;
  }

  if (!("authorization_id" in details)) {
    // 使用者先前已經同意過，Supabase 直接給了 redirect_url，不需要再顯示同意畫面。
    redirect(details.redirect_url);
  }

  const scopes = details.scope
    .split(" ")
    .map((scope) => scope.trim())
    .filter((scope) => scope.length > 0);

  return (
    <main className="mx-auto flex w-[94%] max-w-md flex-1 flex-col gap-5 py-10">
      <header>
        <h1 className="text-xl font-semibold text-foreground">授權存取請求</h1>
        <p className="mt-1 text-sm text-foreground-muted">
          「{details.client.name}」想要以 {details.user.email} 的身分存取你的學習資料。
        </p>
      </header>

      <section className="rounded-2xl border border-border bg-surface p-4">
        <h2 className="text-sm font-medium text-foreground">這個應用程式將可以</h2>
        {scopes.length > 0 ? (
          <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-foreground-muted">
            {scopes.map((scope) => (
              <li key={scope}>{scope}</li>
            ))}
          </ul>
        ) : (
          <p className="mt-2 text-sm text-foreground-muted">讀取你的學習狀態，並在你確認後新增單字。</p>
        )}
        <p className="mt-3 text-xs leading-5 text-foreground-muted">
          新增單字前，這個應用程式仍必須先在對話中把內容呈現給你、取得你的明確確認，才會真正
          寫入；它永遠無法刪除你的任何單字，也無法修改或刪除你的歷史作答紀錄。
        </p>
      </section>

      <form action="/api/oauth/decision" method="POST" className="flex gap-3">
        <input type="hidden" name="authorization_id" value={authorizationId} />
        <button
          type="submit"
          name="decision"
          value="deny"
          className="min-h-12 flex-1 rounded-xl border border-border bg-surface px-4 py-3 text-sm font-semibold text-foreground transition-colors hover:bg-surface-muted"
        >
          拒絕
        </button>
        <button
          type="submit"
          name="decision"
          value="approve"
          className="min-h-12 flex-1 rounded-xl border border-primary bg-primary px-4 py-3 text-sm font-semibold text-primary-foreground transition-colors"
        >
          同意授權
        </button>
      </form>
    </main>
  );
}
