"use client";
import { useRef, useState } from "react";
import { describePersistenceError, mutateRepository } from "@/repository";
import type { Language } from "@/domain/types";
export function AbandonPracticeButton({ sessionId, language = "ja" }: { sessionId: string; language?: Language }) {
  const [confirming, setConfirming] = useState(false),
    [pending, setPending] = useState(false),
    [error, setError] = useState("");
  const busy = useRef(false);
  async function abandon() {
    if (busy.current) return;
    busy.current = true;
    setPending(true);
    setError("");
    try {
      await mutateRepository((r) => {
        if (r.getInProgressSession(language)?.id !== sessionId)
          throw new Error("這輪進度已更新，請重新確認首頁。");
        r.abandonSession(sessionId);
      });
    } catch (e) {
      setError(describePersistenceError(e));
    } finally {
      busy.current = false;
      setPending(false);
    }
  }
  return (
    <div className="min-w-0">
      {confirming ? (
        <div className="flex flex-col gap-2">
          <p className="text-xs text-foreground-muted">
            放棄這輪？已完成的作答與進度會保留。
          </p>
          <button
            type="button"
            disabled={pending}
            onClick={abandon}
            className="min-h-12 rounded-xl border border-danger px-3 text-sm text-danger"
          >
            {pending ? "正在結束…" : "確認放棄"}
          </button>
          <button
            type="button"
            disabled={pending}
            onClick={() => setConfirming(false)}
            className="min-h-11 text-sm text-foreground"
          >
            取消
          </button>
        </div>
      ) : (
        <button
          type="button"
          onClick={() => setConfirming(true)}
          className="min-h-12 w-full rounded-xl border border-border px-3 py-3 text-sm text-foreground"
        >
          放棄練習
        </button>
      )}
      {error ? (
        <p role="alert" className="mt-2 text-xs text-danger">
          {error}
        </p>
      ) : null}
    </div>
  );
}
