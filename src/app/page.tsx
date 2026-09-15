"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

import { computeSevenDayAccuracy, computeStatusCounts, type StatusCounts, type AccuracyResult } from "@/domain/stats";
import { buildTodayQueue, estimateMinutes, limitTodayQueue } from "@/domain/queue";
import { getRepository } from "@/repository";
import { StatCard } from "@/components/StatCard";
import { STATUS_LABELS } from "@/lib/labels";
import { readStudyQuestionCount } from "@/lib/studyPreferences";
import { buildFullReviewUnits, buildWrongAnswerUnits } from "@/domain/practice";

interface HomeData {
  dueCount: number;
  newCount: number;
  estimatedMinutes: number;
  statusCounts: StatusCounts;
  accuracy: AccuracyResult;
  hasInProgressSession: boolean;
  wrongCount: number;
  encounteredCount: number;
}

export default function HomePage() {
  const [data, setData] = useState<HomeData | null>(null);

  useEffect(() => {
    const repository = getRepository();
    const now = new Date();
    const items = repository.listItems({ language: "ja" });
    const scheduleStates = repository.listScheduleStates({ language: "ja" });
    const attempts = repository.listReviewAttempts({ language: "ja" });
    const inProgressSession = repository.getInProgressSession("ja");

    const questionCount = readStudyQuestionCount();
    const queue = limitTodayQueue(buildTodayQueue(items, scheduleStates, now, questionCount), questionCount);
    const statusCounts = computeStatusCounts(items, "ja");
    const accuracy = computeSevenDayAccuracy(attempts, "ja", now);
    const fullReviewUnits = buildFullReviewUnits(items, attempts);

    setData({
      dueCount: queue.reviewUnits.length,
      newCount: queue.newUnits.length,
      estimatedMinutes: estimateMinutes(queue.units.length),
      statusCounts,
      accuracy,
      hasInProgressSession: Boolean(inProgressSession),
      wrongCount: buildWrongAnswerUnits(items, attempts).length,
      encounteredCount: new Set(fullReviewUnits.map((unit) => unit.learningItemId)).size,
    });
  }, []);

  // 有進行中的 session 時一定能繼續（不管今天還有沒有新到期／新內容）。
  const canStudy = data ? data.hasInProgressSession || data.dueCount + data.newCount > 0 : false;

  return (
    <main className="mx-auto flex w-[94%] max-w-xl flex-1 flex-col gap-5 py-6">
      <header>
        <p className="text-xs font-medium text-foreground-muted">AI 語言學習教練・原型</p>
        <h1 className="mt-1 text-xl font-semibold text-foreground">日文學習</h1>
      </header>

      {!data ? (
        <div aria-live="polite" className="space-y-3">
          <div className="h-28 animate-pulse rounded-xl bg-surface-muted" />
          <div className="h-24 animate-pulse rounded-xl bg-surface-muted" />
        </div>
      ) : (
        <>
          <section aria-labelledby="today-summary" className="rounded-2xl border border-border bg-surface p-4">
            <h2 id="today-summary" className="text-sm font-medium text-foreground-muted">
              今天的學習量
            </h2>
            <dl className="mt-3 grid grid-cols-3 gap-3 text-center">
              <div>
                <dt className="text-xs text-foreground-muted">到期複習</dt>
                <dd className="mt-1 text-2xl font-semibold tabular-nums">{data.dueCount}</dd>
              </div>
              <div>
                <dt className="text-xs text-foreground-muted">建議新內容</dt>
                <dd className="mt-1 text-2xl font-semibold tabular-nums">{data.newCount}</dd>
              </div>
              <div>
                <dt className="text-xs text-foreground-muted">預估時間</dt>
                <dd className="mt-1 text-2xl font-semibold tabular-nums">
                  {data.estimatedMinutes}
                  <span className="text-sm font-normal"> 分</span>
                </dd>
              </div>
            </dl>

            <div className="mt-4 flex flex-col gap-2">
              {canStudy ? (
                <Link
                  href="/study"
                  className="rounded-xl bg-primary px-4 py-3 text-center text-sm font-semibold text-primary-foreground transition-colors hover:opacity-90"
                >
                  {data?.hasInProgressSession ? "繼續今日學習" : "開始今日學習"}
                </Link>
              ) : (
                <div>
                  <button
                    type="button"
                    disabled
                    className="w-full cursor-not-allowed rounded-xl bg-surface-muted px-4 py-3 text-sm font-semibold text-foreground-muted"
                  >
                    開始今日學習
                  </button>
                  <p className="mt-1 text-xs text-foreground-muted">目前沒有到期複習或新內容，先新增一個學習項目吧。</p>
                </div>
              )}
              <Link
                href="/add"
                className="rounded-xl border border-border px-4 py-3 text-center text-sm font-medium text-foreground transition-colors hover:bg-surface-muted"
              >
                快速新增內容
              </Link>
            </div>
          </section>

          <section aria-labelledby="self-review" className="rounded-2xl border border-border bg-surface p-4">
            <div className="flex items-center justify-between gap-3">
              <div>
                <h2 id="self-review" className="text-sm font-medium text-foreground">自主複習</h2>
                <p className="mt-1 text-xs text-foreground-muted">不用等到期，選一種方式直接練習。</p>
              </div>
              <Link href="/review" className="shrink-0 text-xs font-medium text-primary underline">
                查看全部
              </Link>
            </div>
            <div className="mt-3 grid grid-cols-2 gap-2">
              <Link
                href="/review#wrong"
                className="min-h-20 rounded-xl bg-danger-bg p-3 transition-opacity hover:opacity-80"
              >
                <span className="block text-sm font-semibold text-danger">錯題專區</span>
                <span className="mt-1 block text-xl font-semibold tabular-nums text-foreground">{data.wrongCount}</span>
                <span className="text-xs text-foreground-muted">待加強題目</span>
              </Link>
              <Link
                href="/review#full"
                className="min-h-20 rounded-xl bg-surface-muted p-3 transition-opacity hover:opacity-80"
              >
                <span className="block text-sm font-semibold text-primary">總複習</span>
                <span className="mt-1 block text-xl font-semibold tabular-nums text-foreground">{data.encounteredCount}</span>
                <span className="text-xs text-foreground-muted">已練過單字</span>
              </Link>
            </div>
          </section>

          <section aria-labelledby="status-overview" className="rounded-2xl border border-border bg-surface p-4">
            <h2 id="status-overview" className="text-sm font-medium text-foreground-muted">
              日文目前進度
            </h2>
            <div className="mt-3 grid grid-cols-2 gap-2">
              <StatCard label="已接觸" value={String(data.statusCounts.total)} />
              <StatCard label={STATUS_LABELS.learning} value={String(data.statusCounts.learning)} />
              <StatCard label={STATUS_LABELS.mastered} value={String(data.statusCounts.mastered)} />
              <StatCard label={STATUS_LABELS.struggling} value={String(data.statusCounts.struggling)} />
            </div>
            <div className="mt-2">
              <StatCard
                label="近 7 日正確率"
                value={data.accuracy.sampleSize > 0 ? `${data.accuracy.accuracyPercent}%` : "—"}
                hint={data.accuracy.sampleSize > 0 ? `依 ${data.accuracy.sampleSize} 筆作答計算` : "近 7 天還沒有作答紀錄"}
              />
            </div>
          </section>

          <section aria-labelledby="english-section" className="rounded-2xl border border-dashed border-border bg-surface-muted p-4">
            <div className="flex items-center gap-2">
              <h2 id="english-section" className="text-sm font-medium text-foreground">
                English
              </h2>
              <span className="rounded-full bg-surface px-2 py-0.5 text-xs font-medium text-foreground-muted">
                下一階段
              </span>
            </div>
            <p className="mt-1 text-sm text-foreground-muted">
              英文的獨立進度與排程尚未開放，目前只有日文垂直切片可以實際使用。
            </p>
          </section>
        </>
      )}
    </main>
  );
}
