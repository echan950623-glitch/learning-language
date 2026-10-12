"use client";
import { useState } from "react";
import { exportLocalBackup, previewLocalBackup, previewLatestRecoveryCopy, restoreLocalBackup, resumeBackupSync, type BackupPreview } from "@/repository/backup";
import { claimGuestData, getAccountOwner, isSyncPaused, readAccountSnapshot, withDataLock } from "@/repository/accountStorage";
import { getRepository, refreshCloudData } from "@/repository";
import { kick } from "@/repository/sync/syncEngine";
import { runInitialMigration } from "@/repository/sync/migration";
import { createBrowserClient } from "@/lib/supabase/client";

export function DataSafetyPanel() {
  const [preview, setPreview] = useState<BackupPreview | null>(null);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  async function run(action: () => void | Promise<void>) {
    if (busy) return;
    setBusy(true); setError("");
    try { await action(); } catch (e) { setError(e instanceof Error ? e.message : "資料操作失敗，原資料已保留。"); }
    finally { setBusy(false); }
  }
  async function download() {
    const contents = await withDataLock(exportLocalBackup);
    const blob = new Blob([contents], { type: "application/json" });
    const url = URL.createObjectURL(blob), a = document.createElement("a");
    a.href = url; a.download = `learning-language-${new Date().toISOString().slice(0, 10)}.json`;
    document.body.appendChild(a); a.click(); a.remove();
    // Let the browser consume the Blob before revoking its URL.
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
    setMessage("已產生備份；請妥善保存學習資料。");
  }
  async function claim() {
    const userId = getAccountOwner();
    if (!userId) throw new Error("請先登入要接收資料的帳戶。");
    if (!readAccountSnapshot(null).values["learning-language:store"]) throw new Error("訪客區沒有已保存的舊資料。");
    await withDataLock(claimGuestData);
    setMessage("已明確認領；訪客原始副本仍保留。正在核對匯入結果。");
    const result = await runInitialMigration({ repository: getRepository(), supabase: createBrowserClient(), userId });
    if (result.phase === "error" || result.phase === "partial_failure") throw new Error(result.message ?? "核對未完成；原始副本及待送操作已保留。");
    refreshCloudData();
  }
  return <section aria-labelledby="data-safety" className="rounded-2xl border border-border bg-surface p-4 space-y-3 text-sm">
    <h2 id="data-safety" className="font-medium">資料備份與還原</h2>
    <p className="text-xs text-foreground-muted">備份包含此帳戶的內容、作答、排程、session、偏好與同步恢復紀錄，不包含登入憑證。還原僅限相同帳戶或訪客歸屬。</p>
    <button disabled={busy} className="min-h-12 rounded-xl border border-border px-4" onClick={() => run(download)}>匯出完整備份</button>
    <button disabled={busy} className="min-h-12 rounded-xl border border-border px-4" onClick={() => run(async () => { const recovery = await withDataLock(previewLatestRecoveryCopy); setPreview(recovery); setMessage("請核對還原前副本；確認後仍只還原本機，並暫停同步。"); })}>預覽最近還原前副本</button>
    <label className="block">選擇備份檔<input type="file" accept="application/json,.json" disabled={busy} className="mt-2 block max-w-full" onChange={e => { const file = e.target.files?.[0]; e.target.value = ""; setPreview(null); if (file) void run(async () => { const contents = await file.text(); setPreview(await withDataLock(() => previewLocalBackup(contents))); setMessage(""); }); }} /></label>
    {preview && <div className="rounded-xl bg-surface-muted p-3 space-y-2">
      <p>歸屬：{preview.backup.owner ?? "訪客"}</p>
      <p>{preview.summary.items} 個內容、{preview.summary.attempts} 筆作答、{preview.summary.sessions} 個 session、{preview.summary.pending} 筆待送操作。</p>
      <p className="text-xs">確認後覆蓋目前帳戶的本機快照；保留還原前副本，並暫停上傳與下載。</p>
      <button disabled={busy} className="min-h-12 rounded-xl border border-border px-4" onClick={() => run(async () => { await restoreLocalBackup(preview); setPreview(null); setMessage("已還原本機資料，同步已暫停。確認內容後才恢復同步。"); })}>確認本機還原</button>
    </div>}
    <button disabled={busy} className="min-h-12 rounded-xl border border-border px-4" onClick={() => run(async () => { if (!getAccountOwner()) throw new Error("請先登入。"); if (!isSyncPaused()) throw new Error("目前沒有暫停的還原同步。"); await resumeBackupSync(); kick(); refreshCloudData(); setMessage("已恢復此帳戶同步；待送操作會依序重試。"); })}>恢復此帳戶同步</button>
    <details><summary className="cursor-pointer">舊版未歸屬資料</summary><p className="mt-2 text-xs text-foreground-muted">舊版資料保留在訪客區，登入不會自動認領。僅適用目前帳戶尚無內容、且舊待送紀錄沒有歸屬衝突的情況。按下即表示確認這份訪客資料屬於目前帳戶，並啟動匯入核對。</p><button disabled={busy} className="mt-2 min-h-12 rounded-xl border border-border px-4" onClick={() => run(claim)}>確認認領並匯入目前帳戶</button></details>
    {message && <p role="status" className="text-xs text-success">{message}</p>}
    {error && <p role="alert" className="text-xs text-danger">{error}</p>}
  </section>;
}
