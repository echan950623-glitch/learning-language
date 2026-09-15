"use client";

import { useEffect, useState } from "react";

import type { AbilityKind, StudySession } from "@/domain/types";
import {
  computeAbilityStatusCounts,
  computeSevenDayAccuracy,
  computeStatusCounts,
  type AccuracyResult,
  type StatusCounts,
} from "@/domain/stats";
import { buildTodayQueue } from "@/domain/queue";
import { formatDurationMs } from "@/domain/time";
import { getRepository } from "@/repository";
import { StatCard } from "@/components/StatCard";
import { EmptyState } from "@/components/EmptyState";
import { STATUS_LABELS } from "@/lib/labels";

const ABILITY_SECTION_LABEL: Record<AbilityKind, string> = {
  recall: "漢字練習",
  reading: "平假名練習",
};

interface ProgressData {
  statusCounts: StatusCounts;
  abilityStatusCounts: Record<AbilityKind, StatusCounts>;
  accuracy: AccuracyResult;
  dueCount: number;
  recentSessions: StudySession[];
}

function formatDateTime(iso: string): string {
  const date = new Date(iso);
  return date.toLocaleString("zh-TW", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export default function ProgressPage() {
  const [data, setData] = useState<ProgressData | null>(null);

  useEffect(() => {
    const repository = getRepository();
    const now = new Date();
    const items = repository.listItems({ language: "ja" });
    const scheduleStates = repository.listScheduleStates({ language: "ja" });
    const attempts = repository.listReviewAttempts({ language: "ja" });
    const recentSessions = repository.listStudySessions({ language: "ja", limit: 10 });

    const queue = buildTodayQueue(items, scheduleStates, now, 0);

    setData({
      statusCounts: computeStatusCounts(items, "ja"),
      abilityStatusCounts: computeAbilityStatusCounts(items, scheduleStates, "ja"),
      accuracy: computeSevenDayAccuracy(attempts, "ja", now),
      dueCount: queue.reviewUnits.length,
      recentSessions,
    });
  }, []);

  return (
    <main className="mx-auto flex w-[94%] max-w-xl flex-1 flex-col gap-5 py-6">
      <header>
        <h1 className="text-xl font-semibold text-foreground">日文進度</h1>
      </header>

      {!data ? (
        <div aria-live="polite" className="space-y-3">
          <div className="h-40 animate-pulse rounded-xl bg-surface-muted" />
          <div className="h-24 animate-pulse rounded-xl bg-surface-muted" />
        </div>
      ) : (
        <>
          <section aria-labelledby="progress-status" className="rounded-2xl border border-border bg-surface p-4">
            <h2 id="progress-status" className="text-sm font-medium text-foreground-muted">
              項目狀態
            </h2>
            <div className="mt-3 grid grid-cols-2 gap-2">
              <StatCard label="已接觸" value={String(data.statusCounts.total)} />
              <StatCard label={STATUS_LABELS.learning} value={String(data.statusCounts.learning)} />
              <StatCard label={STATUS_LABELS.mastered} value={String(data.statusCounts.mastered)} />
              <StatCard label={STATUS_LABELS.struggling} value={String(data.statusCounts.struggling)} />
            </div>
          </section>

          <section aria-labelledby="progress-ability" className="rounded-2xl border border-border bg-surface p-4">
            <h2 id="progress-ability" className="text-sm font-medium text-foreground-muted">
              分項能力狀態
            </h2>
            {(["recall", "reading"] as const).map((ability) => (
              <div key={ability} className="mt-3 first:mt-2">
                <p className="text-xs font-medium text-foreground">{ABILITY_SECTION_LABEL[ability]}</p>
                <div className="mt-2 grid grid-cols-2 gap-2">
                  <StatCard label="已接觸" value={String(data.abilityStatusCounts[ability].total)} />
                  <StatCard label={STATUS_LABELS.learning} value={String(data.abilityStatusCounts[ability].learning)} />
                  <StatCard label={STATUS_LABELS.mastered} value={String(data.abilityStatusCounts[ability].mastered)} />
                  <StatCard
                    label={STATUS_LABELS.struggling}
                    value={String(data.abilityStatusCounts[ability].struggling)}
                  />
                </div>
              </div>
            ))}
          </section>

          <section aria-labelledby="progress-accuracy" className="rounded-2xl border border-border bg-surface p-4">
            <h2 id="progress-accuracy" className="text-sm font-medium text-foreground-muted">
              近期表現
            </h2>
            <div className="mt-3 grid grid-cols-2 gap-2">
              <StatCard
                label="近 7 日正確率"
                value={data.accuracy.sampleSize > 0 ? `${data.accuracy.accuracyPercent}%` : "—"}
                hint={data.accuracy.sampleSize > 0 ? `依 ${data.accuracy.sampleSize} 筆作答計算` : "近 7 天無作答紀錄"}
              />
              <StatCard label="待複習（已到期）" value={String(data.dueCount)} />
            </div>
          </section>

          <section aria-labelledby="progress-history" className="rounded-2xl border border-border bg-surface p-4">
            <h2 id="progress-history" className="text-sm font-medium text-foreground-muted">
              最近學習紀錄
            </h2>
            {data.recentSessions.length === 0 ? (
              <div className="mt-3">
                <EmptyState title="還沒有完成過任何一次今日學習" description="完成第一次學習後，紀錄會顯示在這裡。" />
              </div>
            ) : (
              <ul className="mt-3 flex flex-col gap-2">
                {data.recentSessions.map((session) => {
                  const correct = session.exerciseResults.filter((r) => r.result === "correct").length;
                  const partial = session.exerciseResults.filter((r) => r.result === "partial").length;
                  const incorrect = session.exerciseResults.filter((r) => r.result === "incorrect").length;
                  const totalMs = session.exerciseResults.reduce((sum, r) => sum + r.responseTimeMs, 0);
                  return (
                    <li key={session.id} className="rounded-lg border border-border px-3 py-2">
                      <div className="flex items-center justify-between text-sm">
                        <span className="font-medium text-foreground">{formatDateTime(session.startedAt)}</span>
                        <span className="text-foreground-muted">{formatDurationMs(totalMs)}</span>
                      </div>
                      <p className="mt-0.5 text-xs text-foreground-muted">
                        完成 {session.exerciseResults.length} 題・答對 {correct}・部分 {partial}・答錯 {incorrect}
                      </p>
                    </li>
                  );
                })}
              </ul>
            )}
          </section>
        </>
      )}
    </main>
  );
}
