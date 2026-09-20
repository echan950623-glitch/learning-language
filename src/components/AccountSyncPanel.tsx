"use client";

import React, { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { createBrowserClient } from "@/lib/supabase/client";
import { getSyncDiagnostics, getSyncStatus, subscribeSyncStatus, type SyncStatus } from "@/repository/sync/syncEngine";

const SERVER_SNAPSHOT: SyncStatus = { enabled: false, phase: "idle", pendingCount: 0 };

export function AccountSyncPanel() {
  const [email, setEmail] = useState<string | null>(null);
  const [checked, setChecked] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const sync = useSyncExternalStore(subscribeSyncStatus, getSyncStatus, () => SERVER_SNAPSHOT);
  // 登入後就可展開的唯讀摘要（outbox ＋ 本機 store 結構）；狀態每次變動才重算。
  // 佇列清空之後同樣要看得到——「pendingCount 0 但學習畫面不讓作答」正是需要這份資料的情況。
  const diagnostics = useMemo(() => (sync.enabled ? getSyncDiagnostics() : null), [sync]);

  useEffect(() => {
    let active = true;
    let unsubscribe: (() => void) | undefined;
    try {
      const client = createBrowserClient();
      const { data } = client.auth.onAuthStateChange((_event, session) => {
        if (!active) return;
        setEmail(session?.user.email ?? null);
        setChecked(true);
        setError(null);
      });
      unsubscribe = () => data.subscription.unsubscribe();
      void client.auth.getSession().then(({ data, error }) => {
        if (!active) return;
        if (error) throw error;
        setEmail(data.session?.user.email ?? null);
        setChecked(true);
      }).catch(() => {
        if (active) { setChecked(true); setError("無法確認登入狀態，請重新開啟設定頁後再試。"); }
      });
    } catch {
      setChecked(true);
      setError("雲端登入目前無法使用，本機學習資料仍保留。");
    }
    return () => { active = false; unsubscribe?.(); };
  }, []);

  return (
    <section aria-labelledby="account-sync" className="rounded-2xl border border-border bg-surface p-4">
      <h2 id="account-sync" className="text-sm font-medium text-foreground">帳戶與雲端同步</h2>
      {email ? (
        <div className="mt-3 space-y-2 text-sm">
          <p className="break-all text-foreground">已登入：{email}</p>
          <p role={sync.phase === "error" ? "alert" : "status"} className="text-foreground-muted">
            {!sync.enabled ? "正在啟用同步…" : sync.phase === "idle"
              ? `待同步 ${sync.pendingCount} 筆；目前上傳佇列${sync.pendingCount === 0 ? "已送完" : "仍有資料"}。`
              : sync.phase === "syncing" ? `同步中，待同步 ${sync.pendingCount} 筆。`
              : sync.phase === "offline" ? `離線，待同步 ${sync.pendingCount} 筆；連線恢復後自動上傳。`
              : `同步需要注意：${sync.message ?? "請稍後再試"}（待同步 ${sync.pendingCount} 筆）`}
          </p>
          {diagnostics ? (
            <details className="text-xs text-foreground-muted">
              <summary className="cursor-pointer">同步診斷（唯讀，可截圖回報）</summary>
              <pre className="mt-2 overflow-x-auto whitespace-pre-wrap break-all rounded-lg bg-background p-2 leading-5">{JSON.stringify(diagnostics, null, 2)}</pre>
            </details>
          ) : null}
          <p className="text-xs leading-5 text-foreground-muted">佇列送完不代表其他裝置的舊資料已遷移。請在原本保存學習紀錄的 App 使用相同帳戶登入；若出現衝突，請保留資料並回報，不要清除或重新匯入。</p>
        </div>
      ) : (
        <div className="mt-3 space-y-3">
          <p className="text-xs leading-5 text-foreground-muted">{checked ? "尚未登入，目前學習紀錄只保存在這個瀏覽器或 App。" : "正在確認登入狀態…"} 登入後才能讓 GPT 讀取已同步的學習進度。</p>
          <a href="/auth/sign-in?redirect=%2Fsettings" className="flex min-h-12 items-center justify-center rounded-xl bg-primary px-4 py-3 text-sm font-semibold text-primary-foreground">登入以同步學習紀錄</a>
          <p className="text-xs leading-5 text-foreground-muted">請使用連結 GPT 時相同的 Email。Safari 與主畫面 App 的本機資料可能分開；要上傳舊紀錄，請從原本有單字的 App 登入。</p>
        </div>
      )}
      {error ? <p role="alert" className="mt-3 text-xs text-danger">{error}</p> : null}
    </section>
  );
}
