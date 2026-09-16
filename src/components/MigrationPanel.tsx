"use client";

import { useState, useSyncExternalStore } from "react";

import { createBrowserClient } from "@/lib/supabase/client";
import { getRepository } from "@/repository";
import {
  getMigrationStatus,
  runInitialMigration,
  subscribeMigrationStatus,
  type MigrationStatus,
} from "@/repository/sync/migration";

const SERVER_SNAPSHOT: MigrationStatus = { phase: "unknown" };

/**
 * 遷移狀態面板：`AuthSyncBootstrapper` 登入後會自動呼叫一次 `runInitialMigration`，
 * 這裡負責把過程／結果顯示出來，並在失敗時提供明確的重試入口（遷移本身冪等、
 * 重試永遠安全，見 migration.ts 開頭註解）。`unknown`（還沒檢查過，例如尚未登入）與
 * `not_needed`（沒有本機資料需要遷移，或已經完成過）都不顯示這個區塊，避免在沒事
 * 發生時佔用設定頁版面。
 */
export function MigrationPanel() {
  const status = useSyncExternalStore(subscribeMigrationStatus, getMigrationStatus, () => SERVER_SNAPSHOT);
  const [isRetrying, setIsRetrying] = useState(false);
  const [retryError, setRetryError] = useState<string | null>(null);

  if (status.phase === "unknown" || status.phase === "not_needed") {
    return null;
  }

  async function handleRetry(): Promise<void> {
    setIsRetrying(true);
    setRetryError(null);
    try {
      const supabase = createBrowserClient();
      const {
        data: { session },
      } = await supabase.auth.getSession();
      if (!session) {
        setRetryError("目前不是登入狀態，無法遷移。");
        return;
      }
      await runInitialMigration({ repository: getRepository(), supabase, userId: session.user.id });
    } catch (error) {
      console.error("【資料遷移】重試失敗:", {
        message: error instanceof Error ? error.message : String(error),
        timestamp: new Date().toISOString(),
      });
      setRetryError("重試失敗，請稍後再試一次。");
    } finally {
      setIsRetrying(false);
    }
  }

  return (
    <section aria-labelledby="migration-panel" className="rounded-2xl border border-border bg-surface p-4">
      <h2 id="migration-panel" className="text-sm font-medium text-foreground">
        資料遷移到雲端
      </h2>

      {status.phase === "running" ? (
        <div className="mt-3">
          <p className="text-xs text-foreground-muted">
            遷移中…{status.progress ? `${status.progress.completed} / ${status.progress.total}` : ""}
          </p>
          <div className="mt-2 h-2 overflow-hidden rounded-full bg-surface-muted">
            <div
              className="h-full rounded-full bg-primary transition-all"
              style={{
                width:
                  status.progress && status.progress.total > 0
                    ? `${Math.min(100, Math.round((status.progress.completed / status.progress.total) * 100))}%`
                    : "0%",
              }}
            />
          </div>
        </div>
      ) : null}

      {status.phase === "completed" ? (
        <div className="mt-3">
          <p role="status" className="text-xs text-success">
            已完成，本機學習紀錄已經同步到雲端。
          </p>
          {status.categories ? (
            <ul className="mt-2 space-y-1 text-xs text-foreground-muted">
              {status.categories.map((category) => (
                <li key={category.key} className="flex justify-between">
                  <span>{category.label}</span>
                  <span className="tabular-nums">
                    {category.remoteCount} / {category.localCount}
                  </span>
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}

      {status.phase === "partial_failure" || status.phase === "error" ? (
        <div className="mt-3 space-y-2">
          <p role="alert" className="text-xs text-danger">
            {status.message ?? "遷移過程發生問題，部分資料可能尚未同步完成。"}
          </p>
          {status.categories ? (
            <ul className="space-y-1 text-xs text-foreground-muted">
              {status.categories.map((category) => (
                <li key={category.key} className="flex justify-between">
                  <span className={category.ok ? "" : "text-danger"}>{category.label}</span>
                  <span className="tabular-nums">
                    {category.remoteCount} / {category.localCount}
                  </span>
                </li>
              ))}
            </ul>
          ) : null}
          <button
            type="button"
            onClick={handleRetry}
            disabled={isRetrying}
            className="w-full rounded-xl border border-border px-4 py-2 text-center text-sm font-medium text-foreground transition-colors hover:bg-surface-muted disabled:cursor-not-allowed disabled:opacity-50"
          >
            {isRetrying ? "重試中…" : "重試遷移"}
          </button>
          {retryError ? (
            <p role="alert" className="text-xs text-danger">
              {retryError}
            </p>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
