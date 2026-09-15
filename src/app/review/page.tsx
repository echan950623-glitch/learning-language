"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";

import { buildFullReviewUnits, buildWrongAnswerUnits } from "@/domain/practice";
import type { StudySessionPlannedUnit } from "@/domain/types";
import { readStudyQuestionCount } from "@/lib/studyPreferences";
import { describePersistenceError, getRepository } from "@/repository";

interface ReviewData {
  wrongUnits: StudySessionPlannedUnit[];
  fullUnits: StudySessionPlannedUnit[];
  encounteredItemCount: number;
  questionCount: number;
  hasInProgressSession: boolean;
}

type ReviewMode = "wrong" | "full";

export default function ReviewPage() {
  const router = useRouter();
  const [data, setData] = useState<ReviewData | null>(null);
  const [startingMode, setStartingMode] = useState<ReviewMode | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const repository = getRepository();
    const items = repository.listItems({ language: "ja" });
    const attempts = repository.listReviewAttempts({ language: "ja" });
    const fullUnits = buildFullReviewUnits(items, attempts);

    setData({
      wrongUnits: buildWrongAnswerUnits(items, attempts),
      fullUnits,
      encounteredItemCount: new Set(fullUnits.map((unit) => unit.learningItemId)).size,
      questionCount: readStudyQuestionCount(),
      hasInProgressSession: Boolean(repository.getInProgressSession("ja")),
    });
  }, []);

  function startReview(mode: ReviewMode) {
    if (!data || data.hasInProgressSession) return;

    const availableUnits = mode === "wrong" ? data.wrongUnits : data.fullUnits;
    const plannedUnits = availableUnits.slice(0, data.questionCount);
    if (plannedUnits.length === 0) return;

    setStartingMode(mode);
    setError(null);
    try {
      getRepository().getOrCreateInProgressSession("ja", plannedUnits, new Date());
      router.push("/study");
    } catch (caught) {
      setError(describePersistenceError(caught));
      setStartingMode(null);
    }
  }

  if (!data) {
    return (
      <main className="mx-auto flex w-[94%] max-w-xl flex-1 flex-col gap-4 py-6" aria-live="polite">
        <div className="h-7 w-32 animate-pulse rounded bg-surface-muted" />
        <div className="h-44 animate-pulse rounded-2xl bg-surface-muted" />
        <div className="h-44 animate-pulse rounded-2xl bg-surface-muted" />
      </main>
    );
  }

  const wrongSessionCount = Math.min(data.questionCount, data.wrongUnits.length);
  const fullSessionCount = Math.min(data.questionCount, data.fullUnits.length);

  return (
    <main className="mx-auto flex w-[94%] max-w-xl flex-1 flex-col gap-5 py-6">
      <header>
        <h1 className="text-xl font-semibold text-foreground">自主複習</h1>
        <p className="mt-1 text-sm leading-6 text-foreground-muted">
          不用等排程到期，隨時從錯題或所有練過的內容開始複習。
        </p>
      </header>

      {data.hasInProgressSession ? (
        <section className="rounded-2xl border border-primary bg-surface p-4" aria-labelledby="active-session">
          <h2 id="active-session" className="text-sm font-semibold text-foreground">
            你有尚未完成的學習
          </h2>
          <p className="mt-1 text-sm leading-6 text-foreground-muted">先完成或放棄目前的題目，才能開始新的自主複習。</p>
          <Link
            href="/study"
            className="mt-3 block min-h-12 rounded-xl bg-primary px-4 py-3 text-center text-sm font-semibold text-primary-foreground"
          >
            繼續目前學習
          </Link>
        </section>
      ) : null}

      <section id="wrong" aria-labelledby="wrong-title" className="scroll-mt-4 rounded-2xl border border-border bg-surface p-4">
        <div className="flex items-start justify-between gap-3">
          <div>
            <p className="text-xs font-medium text-danger">針對弱點</p>
            <h2 id="wrong-title" className="mt-1 text-lg font-semibold text-foreground">錯題專區</h2>
          </div>
          <span className="shrink-0 rounded-full bg-danger-bg px-3 py-1 text-sm font-semibold tabular-nums text-danger">
            {data.wrongUnits.length} 題
          </span>
        </div>
        <p className="mt-3 text-sm leading-6 text-foreground-muted">
          收錄每個單字目前仍答錯的漢字或平假名能力；之後答對，就會自動離開錯題。
        </p>
        <button
          type="button"
          onClick={() => startReview("wrong")}
          disabled={data.hasInProgressSession || wrongSessionCount === 0 || startingMode !== null}
          className="mt-4 min-h-12 w-full rounded-xl bg-primary px-4 py-3 text-sm font-semibold text-primary-foreground transition-opacity disabled:cursor-not-allowed disabled:opacity-45"
        >
          {wrongSessionCount > 0 ? `開始錯題複習（${wrongSessionCount} 題）` : "目前沒有未解決錯題"}
        </button>
      </section>

      <section id="full" aria-labelledby="full-title" className="scroll-mt-4 rounded-2xl border border-border bg-surface p-4">
        <div className="flex items-start justify-between gap-3">
          <div>
            <p className="text-xs font-medium text-primary">不限到期日</p>
            <h2 id="full-title" className="mt-1 text-lg font-semibold text-foreground">總複習</h2>
          </div>
          <span className="shrink-0 rounded-full bg-surface-muted px-3 py-1 text-sm font-semibold tabular-nums text-foreground">
            {data.encounteredItemCount} 個字
          </span>
        </div>
        <p className="mt-3 text-sm leading-6 text-foreground-muted">
          所有曾經作答過的單字都可以出題；優先安排最久沒練與尚未練過的能力。
        </p>
        <button
          type="button"
          onClick={() => startReview("full")}
          disabled={data.hasInProgressSession || fullSessionCount === 0 || startingMode !== null}
          className="mt-4 min-h-12 w-full rounded-xl border border-primary bg-surface px-4 py-3 text-sm font-semibold text-primary transition-colors hover:bg-surface-muted disabled:cursor-not-allowed disabled:border-border disabled:text-foreground-muted disabled:opacity-60"
        >
          {fullSessionCount > 0 ? `開始總複習（${fullSessionCount} 題）` : "完成至少一題後即可總複習"}
        </button>
      </section>

      <p className="text-center text-xs leading-5 text-foreground-muted">
        每次題數沿用你的學習設定，目前是 {data.questionCount} 題上限。
      </p>

      {error ? (
        <p role="alert" className="rounded-xl bg-danger-bg px-4 py-3 text-sm text-danger">
          {error}
        </p>
      ) : null}
    </main>
  );
}
