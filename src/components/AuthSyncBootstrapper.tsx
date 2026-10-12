"use client";

import { useEffect } from "react";
import type { Session, SupabaseClient } from "@supabase/supabase-js";

import { createBrowserClient } from "@/lib/supabase/client";
import { configureCloudSync, markRepositoryAuthInitialized } from "@/repository";


/**
 * 掛載一次，監聽 Supabase auth 狀態並驅動雲端同步的開關（見 ARCHITECTURE.md「資料流
 * 總覽」）：
 * - 登入：呼叫 `configureCloudSync({ supabase, userId })`（切換 singleton、觸發
 *   pull-merge）。舊版未歸屬資料由使用者在設定頁明確認領；不自動匯入。
 * - 登出／尚未登入：呼叫 `configureCloudSync(null)`，回到純本機行為。
 *
 * 不在畫面上顯示任何東西；同步狀態由設定頁的 `AccountSyncPanel` 訂閱顯示，
 * 遷移進度由 `MigrationPanel`（設定頁）另外訂閱顯示。
 */
export function AuthSyncBootstrapper() {
  useEffect(() => {
    let active = true;
    let authEventReceived = false;
    let supabase: SupabaseClient;

    try {
      supabase = createBrowserClient();
    } catch (error) {
      // 環境變數還沒備妥（例如本機開發忘了設定 .env.local）：完全略過雲端同步，
      // App 其餘部分（本機優先）行為不受影響，不讓整個 App 因此掛掉。
      console.warn("[learning-language] 無法建立 Supabase 用戶端，本次略過雲端同步", error);
      markRepositoryAuthInitialized();
      return;
    }

    function handleSession(session: Session | null): void {
      if (!active) return;

      if (!session) {
        configureCloudSync(null);
        markRepositoryAuthInitialized();
        return;
      }

      const userId = session.user.id;
      configureCloudSync({ supabase, userId });
      markRepositoryAuthInitialized();
    }

    supabase.auth
      .getSession()
      .then(({ data }) => { if (!authEventReceived) handleSession(data.session); })
      .catch((error) => {
        console.warn("[learning-language] 讀取登入狀態失敗", error);
        markRepositoryAuthInitialized();
      });

    const { data: authListener } = supabase.auth.onAuthStateChange((_event, session) => {
      authEventReceived = true;
      handleSession(session);
    });

    return () => {
      active = false;
      authListener.subscription.unsubscribe();
    };
  }, []);

  return null;
}
