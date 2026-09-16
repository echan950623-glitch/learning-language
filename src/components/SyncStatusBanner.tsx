"use client";

import { useSyncExternalStore } from "react";

import { getSyncStatus, subscribeSyncStatus, type SyncStatus } from "@/repository/sync/syncEngine";

const SERVER_SNAPSHOT: SyncStatus = { enabled: false, phase: "idle", pendingCount: 0 };

/**
 * 顯示雲端同步狀態：已同步／同步中／離線佇列 N 筆／需要注意，跟既有的
 * `DurabilityBanner` 同一種視覺風格（見該檔案），掛在 layout.tsx 裡它旁邊。
 * 未登入（`enabled === false`）時完全不顯示——跟 DurabilityBanner「沒事就不顯示」
 * 的既有慣例一致，不會在使用者還沒登入時就佔用畫面空間。
 */
export function SyncStatusBanner() {
  const status = useSyncExternalStore(subscribeSyncStatus, getSyncStatus, () => SERVER_SNAPSHOT);

  if (!status.enabled) return null;

  if (status.phase === "idle") {
    return (
      <div role="status" className="bg-success-bg px-4 py-2 text-center text-xs font-medium text-success">
        已同步
      </div>
    );
  }

  if (status.phase === "syncing") {
    return (
      <div role="status" className="bg-surface-muted px-4 py-2 text-center text-xs font-medium text-foreground-muted">
        同步中…{status.pendingCount > 0 ? `（剩 ${status.pendingCount} 筆）` : ""}
      </div>
    );
  }

  if (status.phase === "offline") {
    return (
      <div role="status" className="bg-warning-bg px-4 py-2 text-center text-xs font-medium text-warning">
        離線佇列 {status.pendingCount} 筆，恢復連線後會自動同步
      </div>
    );
  }

  return (
    <div role="alert" className="bg-danger-bg px-4 py-2 text-center text-xs font-medium text-danger">
      需要注意：{status.message ?? "同步發生問題"}
      {status.pendingCount > 0 ? `（待同步 ${status.pendingCount} 筆）` : ""}
    </div>
  );
}
