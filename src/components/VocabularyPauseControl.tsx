"use client";

import { useRef, useState } from "react";
import { describePersistenceError, mutateRepository } from "@/repository";
import { setVocabularyPaused } from "@/repository/vocabularyPause";

/** Separate cancel/confirm state; rapid double taps cannot confirm the verification request. */
export function ConfirmVocabularyVerification({ onConfirm, disabled }: { onConfirm: () => Promise<void>; disabled: boolean }) {
  const [armed, setArmed] = useState(false);
  const armedAt = useRef(0);
  const pending = useRef(false);
  const style = "min-h-11 rounded-xl border border-border px-4 py-2.5 text-sm font-medium text-foreground hover:bg-surface-muted";
  return <div className="flex flex-wrap items-center gap-2">
    <button type="button" disabled={disabled} className={style} onClick={async () => {
      if (!armed) { armedAt.current = performance.now(); setArmed(true); return; }
      if (pending.current || performance.now() - armedAt.current < 500) return;
      pending.current = true;
      try { await onConfirm(); } finally { pending.current = false; setArmed(false); }
    }}>{armed ? "再按一次，交給系統驗證" : "這個已會，改為定期驗證"}</button>
    {armed ? <>
      <button type="button" disabled={disabled} className={style} onClick={() => setArmed(false)}>取消</button>
      <p role="status" className="w-full text-xs text-foreground-muted">先跳過這輪，明天起自動安排驗證；通過後才會拉長間隔。這次不算答對。</p>
    </> : null}
  </div>;
}

export function ResumeVocabularyButton({ id }: { id: string }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  return <div className="mt-3">
    <button type="button" disabled={busy} className="min-h-11 rounded-lg border border-border px-3 py-2 text-sm text-foreground hover:bg-surface-muted" onClick={async () => {
      setBusy(true); setError("");
      try { await mutateRepository(repository => setVocabularyPaused(repository, id, false, new Date())); }
      catch (failure) { setError(describePersistenceError(failure)); }
      finally { setBusy(false); }
    }}>恢復出題</button>
    {error ? <p role="alert" className="mt-2 text-sm text-foreground">{error}</p> : null}
  </div>;
}
