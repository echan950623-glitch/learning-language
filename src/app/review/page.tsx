"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";

import { buildWrongAnswerUnits } from "@/domain/practice";
import { PRACTICE_CATEGORIES, selectMixedReviewUnits, type PracticeCategory } from "@/domain/practiceSelection";
import { matchesLevels } from "@/domain/jlptLevels";
import type { StudySessionPlannedUnit } from "@/domain/types";
import { LevelFilterChips, useLevelFilter } from "@/components/LevelFilter";
import { readLevelFilter } from "@/lib/levelFilter";
import { readStudyQuestionCount } from "@/lib/studyPreferences";
import { describePersistenceError, getRepository, mutateRepository, subscribeDataChanged } from "@/repository";

interface ReviewData {
  wrongUnits: StudySessionPlannedUnit[];
  mixedTotal: number;
  byCategory: Record<PracticeCategory, number>;
  questionCount: number;
  hasInProgressSession: boolean;
}

type ReviewMode = "wrong" | "full";

/** The review hub: one mixed round over everything learned, the unresolved mistakes, and each area on its own. */
export default function ReviewPage() {
  const router = useRouter();
  const [data, setData] = useState<ReviewData | null>(null);
  const [startingMode, setStartingMode] = useState<ReviewMode | null>(null);
  const [error, setError] = useState<string | null>(null);
  const levels = useLevelFilter();

  useEffect(() => {
    const refresh = () => {
      const repository = getRepository();
      const items = repository.listItems({ language: "ja" }).filter(item => matchesLevels(item, levels));
      const attempts = repository.listReviewAttempts({ language: "ja" });
      const questionCount = readStudyQuestionCount();
      const mixed = selectMixedReviewUnits(items, attempts, repository.listScheduleStates({ language: "ja" }), questionCount, new Date());
      setData({
        wrongUnits: buildWrongAnswerUnits(items, attempts),
        mixedTotal: mixed.total,
        byCategory: mixed.byCategory,
        questionCount,
        hasInProgressSession: Boolean(repository.getInProgressSession("ja")),
      });
    };
    refresh();
    return subscribeDataChanged(refresh);
  }, [levels]);

  async function startReview(mode: ReviewMode) {
    if (!data || data.hasInProgressSession || startingMode) return;
    setStartingMode(mode);
    setError(null);
    try {
      await mutateRepository(repository => {
        if (repository.getInProgressSession("ja")) return;
        const items = repository.listItems({ language: "ja" }).filter(item => matchesLevels(item, readLevelFilter()));
        const attempts = repository.listReviewAttempts({ language: "ja" });
        const now = new Date();
        // Pick the questions inside the write so the round reflects the data it is saved against.
        const units = mode === "wrong"
          ? buildWrongAnswerUnits(items, attempts).slice(0, data.questionCount)
          : selectMixedReviewUnits(items, attempts, repository.listScheduleStates({ language: "ja" }), data.questionCount, now).units;
        if (!units.length) throw new Error("目前沒有可複習的題目。");
        return repository.getOrCreateInProgressSession("ja", units, now, { mode });
      });
      router.push("/study");
    } catch (caught) {
      setError(describePersistenceError(caught));
      setStartingMode(null);
    }
  }

  if (!data) {
    return (
      <main className="mx-auto flex w-[88%] max-w-xl flex-1 flex-col gap-5 pb-8 pt-6" aria-live="polite">
        <div className="h-7 w-32 animate-pulse rounded bg-surface-muted" />
        <div className="h-44 animate-pulse rounded-2xl bg-surface-muted" />
        <div className="h-44 animate-pulse rounded-2xl bg-surface-muted" />
      </main>
    );
  }

  const mixedCount = Math.min(data.questionCount, data.mixedTotal);
  const wrongCount = Math.min(data.questionCount, data.wrongUnits.length);
  const blocked = data.hasInProgressSession || startingMode !== null;
  const rounds = [
    { mode: "full", title: "混合複習", note: "單字、文法、句構、搭配與閱讀輪流出題；到期與答錯的優先。", total: data.mixedTotal, unit: "題可複習", count: mixedCount, label: "開始混合複習", empty: "學過內容後即可複習" },
    { mode: "wrong", title: "錯題", note: "最近一次仍答錯的題目；之後答對就會離開。", total: data.wrongUnits.length, unit: "題未解決", count: wrongCount, label: "開始錯題複習", empty: "目前沒有未解決錯題" },
  ] as const;

  return (
    <main className="mx-auto flex w-[88%] max-w-xl flex-1 flex-col gap-12 pb-10 pt-8">
      <header>
        <p className="eyebrow">Review</p>
        <h1 className="mt-2 font-display text-4xl font-medium tracking-tight text-foreground">複習</h1>
        <p className="mt-3 text-sm leading-6 text-foreground-muted">
          不用等排程到期，隨時複習學過的內容。每輪最多 {data.questionCount} 題，可在設定調整。
        </p>
      </header>

      {data.hasInProgressSession ? (
        <section aria-labelledby="active-session">
          <h2 id="active-session" className="eyebrow">尚未完成的學習</h2>
          <p className="mt-3 text-sm leading-6 text-foreground-muted">先完成或放棄目前的題目，才能開始新的複習。</p>
          <Link href="/study" className="mt-3 flex min-h-12 items-center justify-between rounded-xl bg-primary px-4 text-sm font-semibold text-primary-foreground">
            <span>繼續目前學習</span><span aria-hidden="true">→</span>
          </Link>
        </section>
      ) : null}

      <section aria-labelledby="review-levels">
        <h2 id="review-levels" className="eyebrow">級別</h2>
        <div className="mt-3"><LevelFilterChips /></div>
        <p className="mt-3 text-xs leading-5 text-foreground-muted">
          {levels.length ? "只套用在這一頁的複習與單項練習。首頁的到期複習不分級別，照常出現。" : "目前複習所有級別。可複選想複習的程度。"}
        </p>
      </section>

      <section aria-labelledby="review-rounds">
        <h2 id="review-rounds" className="eyebrow">開始一輪</h2>
        <div className="mt-3 border-t border-border">
          {rounds.map((round, index) => (
            <article key={round.mode} id={round.mode} className="scroll-mt-4 border-b border-border py-5">
              <div className="flex items-end justify-between gap-4">
                <div className="min-w-0">
                  <h3 className="text-lg font-medium text-foreground">{round.title}</h3>
                  <p className="mt-1 text-xs leading-5 text-foreground-muted">{round.note}</p>
                </div>
                <p className="shrink-0 text-right">
                  <span className="block font-display text-5xl font-medium leading-none tabular-nums text-foreground">{round.total}</span>
                  <span className="mt-1 block text-xs text-foreground-muted">{round.unit}</span>
                </p>
              </div>
              <button
                type="button"
                onClick={() => startReview(round.mode)}
                disabled={blocked || round.count === 0}
                className={`mt-4 flex min-h-12 w-full items-center justify-between rounded-xl px-4 text-sm font-semibold disabled:border disabled:border-border disabled:bg-transparent disabled:font-normal disabled:text-foreground-muted ${index === 0 ? "bg-primary text-primary-foreground" : "border border-foreground text-foreground"}`}
              >
                <span>{round.count > 0 ? `${round.label}（${round.count} 題）` : round.empty}</span>
                {round.count > 0 ? <span aria-hidden="true">→</span> : null}
              </button>
            </article>
          ))}
        </div>
        {error ? <p role="alert" className="mt-3 text-sm text-danger">{error}</p> : null}
      </section>

      <section aria-labelledby="review-areas">
        <h2 id="review-areas" className="eyebrow">單項練習</h2>
        <ul className="mt-3 border-t border-border">
          {PRACTICE_CATEGORIES.map((category) => {
            const count = data.byCategory[category.id];
            return (
              <li key={category.id} className={count === 0 ? "opacity-55" : ""}>
                <Link href={`/practice?category=${category.id}`} className="flex min-h-14 items-center gap-3 border-b border-border py-3">
                  <span className="min-w-0 flex-1">
                    <span className="block font-medium text-foreground">{category.label}</span>
                    <span className="mt-0.5 block truncate text-xs text-foreground-muted">{category.description}</span>
                  </span>
                  <span className="shrink-0 text-xs tabular-nums text-foreground-muted">{count === 0 ? "尚無內容" : `${count} 題`}</span>
                  <span aria-hidden="true" className="shrink-0 text-foreground-muted">→</span>
                </Link>
              </li>
            );
          })}
        </ul>
        <p className="mt-4 text-xs leading-5 text-foreground-muted">
          尚無內容的類別，可到下方的內容庫開啟。自主複習不會反覆延長排程間隔。
        </p>
      </section>

      <nav aria-label="更多" className="border-t border-border">
        <Link href="/library" className="flex min-h-14 items-center justify-between gap-3 border-b border-border py-3 text-sm text-foreground">
          <span><span className="block font-medium">內容庫</span><span className="mt-0.5 block text-xs text-foreground-muted">依級別開啟文法、句構與讀解練習</span></span><span aria-hidden="true" className="text-foreground-muted">→</span>
        </Link>
        <Link href="/progress" className="flex min-h-14 items-center justify-between gap-3 border-b border-border py-3 text-sm text-foreground">
          <span className="font-medium">單字庫與學習紀錄</span><span aria-hidden="true" className="text-foreground-muted">→</span>
        </Link>
      </nav>
    </main>
  );
}
