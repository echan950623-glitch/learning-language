"use client";

import { useEffect } from "react";
import type { Session, SupabaseClient } from "@supabase/supabase-js";

import { createBrowserClient } from "@/lib/supabase/client";
import { configureCloudSync, getRepository } from "@/repository";
import { runInitialMigration } from "@/repository/sync/migration";

/**
 * 掛載一次，監聽 Supabase auth 狀態並驅動雲端同步的開關（見 ARCHITECTURE.md「資料流
 * 總覽」）：
 * - 登入：呼叫 `configureCloudSync({ supabase, userId })`（切換 singleton、觸發
 *   pull-merge），並嘗試 `runInitialMigration`——遷移本身有「已完成」偵測與防重入，
 *   每次登入都呼叫是安全的 no-op（尚未完成才會真的執行）。
 * - 登出／尚未登入：呼叫 `configureCloudSync(null)`，回到純本機行為。
 *
 * 不在畫面上顯示任何東西；同步狀態由 `SyncStatusBanner` 另外訂閱顯示，
 * 遷移進度由 `MigrationPanel`（設定頁）另外訂閱顯示。
 */
export function AuthSyncBootstrapper() {
  useEffect(() => {
    let active = true;
    let supabase: SupabaseClient;

    try {
      supabase = createBrowserClient();
    } catch (error) {
      // 環境變數還沒備妥（例如本機開發忘了設定 .env.local）：完全略過雲端同步，
      // App 其餘部分（本機優先）行為不受影響，不讓整個 App 因此掛掉。
      console.warn("[learning-language] 無法建立 Supabase 用戶端，本次略過雲端同步", error);
      return;
    }

    function handleSession(session: Session | null): void {
      if (!active) return;

      if (!session) {
        configureCloudSync(null);
        return;
      }

      const userId = session.user.id;
      // 先抓「這次登入事件當下」的 repository 參照：migration 的偵測條件（本機是否有
      // 尚未同步的資料）必須看這個當下的本機快照，不能看之後 pull-merge 完成、singleton
      // 的 inner 被換掉之後的版本——見 migration.ts 開頭註解與 ARCHITECTURE.md 的
      // migration 一節。
      const repository = getRepository();
      configureCloudSync({ supabase, userId });
      void runInitialMigration({ repository, supabase, userId }).catch((error) => {
        console.warn("[learning-language] 初始遷移失敗，可以之後在設定頁重試", error);
      });
    }

    supabase.auth
      .getSession()
      .then(({ data }) => handleSession(data.session))
      .catch((error) => {
        console.warn("[learning-language] 讀取登入狀態失敗", error);
      });

    const { data: authListener } = supabase.auth.onAuthStateChange((_event, session) => {
      handleSession(session);
    });

    return () => {
      active = false;
      authListener.subscription.unsubscribe();
    };
  }, []);

  return null;
}
