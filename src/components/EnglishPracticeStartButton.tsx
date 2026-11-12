"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useRef, useState } from "react";
import { selectEnglishPracticeUnits, type EnglishPracticeSelection } from "@/domain/englishPracticeSelection";
import { describePersistenceError, mutateRepository, waitForRepositoryInitialization } from "@/repository";
import { usePracticeData } from "./PracticeLauncher";

export function EnglishPracticeStartButton({ selection, compact = false }: { selection: EnglishPracticeSelection; compact?: boolean }) {
  const { data, error: loadError } = usePracticeData("en");
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);
  const busy = useRef(false);
  const router = useRouter();
  const result = data ? selectEnglishPracticeUnits(data.items, data.attempts, data.schedules, selection, new Date(), () => 0.5) : undefined;
  async function start() {
    if (busy.current) return;
    busy.current = true;
    setPending(true);
    setError("");
    try {
      await waitForRepositoryInitialization();
      await mutateRepository(repository => {
        if (repository.getInProgressSession("en")) return;
        const now = new Date();
        const selected = selectEnglishPracticeUnits(repository.listItems({ language: "en" }), repository.listReviewAttempts({ language: "en" }), repository.listScheduleStates({ language: "en" }), selection, now);
        if (!selected.units.length) throw new Error("這個範圍目前沒有可練的題目。請調整範圍，或先完成今日學習。");
        return repository.getOrCreateInProgressSession("en", selected.units, now, { mode: selected.mode });
      });
      router.push("/study?language=en");
    } catch (e) {
      setError(describePersistenceError(e));
    } finally {
      busy.current = false;
      setPending(false);
    }
  }
  return <div>
    {data?.session && !compact ? <Link href="/study?language=en" className="flex min-h-12 items-center justify-center rounded-xl border border-foreground px-4 text-sm font-semibold text-foreground">繼續上次英文練習</Link> :
      <button type="button" onClick={start} disabled={!data || pending || !!data.session || !result?.units.length} className={compact
        ? "min-h-11 w-full rounded-xl border border-foreground px-2 text-xs font-semibold text-foreground disabled:border-border disabled:text-foreground-muted"
        : "min-h-12 w-full rounded-xl bg-primary px-4 text-sm font-semibold text-primary-foreground disabled:opacity-40"}>
        {pending ? (compact ? "準備中…" : "準備題目…") : data?.session ? (compact ? "進行中" : "練習進行中") : data && !result?.units.length ? "尚無可練內容" : compact ? "練習" : "開始練習"}
      </button>}
    {loadError || error ? <p role="alert" className="mt-2 text-xs text-danger">{loadError || error}</p> : null}
  </div>;
}
