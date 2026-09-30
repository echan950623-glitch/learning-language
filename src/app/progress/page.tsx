"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

import type { AbilityKind, ItemStatus, LearningItem } from "@/domain/types";
import {
  computeAbilityStatusCounts,
  computeSevenDayAccuracy,
  computeStatusCounts,
  type AccuracyResult,
  type StatusCounts,
} from "@/domain/stats";
import { buildTodayQueue } from "@/domain/queue";
import { getRepository } from "@/repository";
import { StatCard } from "@/components/StatCard";
import { EmptyState } from "@/components/EmptyState";
import { SOURCE_LABELS, STATUS_LABELS } from "@/lib/labels";

const ABILITY_SECTION_LABEL: Record<AbilityKind, string> = {
  recall: "漢字練習",
  reading: "平假名練習",
};

interface ProgressData {
  items: LearningItem[];
  statusCounts: StatusCounts;
  abilityStatusCounts: Record<AbilityKind, StatusCounts>;
  accuracy: AccuracyResult;
  dueCount: number;
}

const STATUS_FILTERS: { value: ItemStatus | "all"; label: string }[] = [
  { value: "all", label: "全部" },
  { value: "learning", label: STATUS_LABELS.learning },
  { value: "mastered", label: STATUS_LABELS.mastered },
  { value: "struggling", label: STATUS_LABELS.struggling },
  { value: "new", label: "未學習" },
];
const PAGE_SIZE = 20;

export default function ProgressPage() {
  const [data, setData] = useState<ProgressData | null>(null);
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<ItemStatus | "all">("all");
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE);

  useEffect(() => {
    const repository = getRepository();
    const now = new Date();
    const items = repository.listItems({ language: "ja" });
    const scheduleStates = repository.listScheduleStates({ language: "ja" });
    const attempts = repository.listReviewAttempts({ language: "ja" });

    const queue = buildTodayQueue(items, scheduleStates, now, 0);

    setData({
      items: items.filter((item) => item.type === "vocabulary").sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
      statusCounts: computeStatusCounts(items, "ja"),
      abilityStatusCounts: computeAbilityStatusCounts(items, scheduleStates, "ja"),
      accuracy: computeSevenDayAccuracy(attempts, "ja", now),
      dueCount: queue.reviewUnits.length,
    });
  }, []);

  const query = search.trim().toLocaleLowerCase();
  const filteredItems = data?.items.filter((item) => {
    if (statusFilter !== "all" && item.status !== statusFilter) return false;
    if (!query) return true;
    return [item.answer, item.reading, item.promptZh].some((value) => value?.toLocaleLowerCase().includes(query));
  }) ?? [];
  const visibleItems = filteredItems.slice(0, visibleCount);

  return (
    <main className="mx-auto flex w-[94%] max-w-xl flex-1 flex-col gap-4 py-6">
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
          <details className="group rounded-2xl border border-border bg-surface p-4">
            <summary className="flex min-h-11 cursor-pointer list-none items-center justify-between gap-3 text-sm font-medium text-foreground marker:content-none [&::-webkit-details-marker]:hidden">
              <span>項目狀態</span><span className="text-foreground-muted">{data.statusCounts.total} 項 <span aria-hidden="true" className="inline-block transition-transform group-open:rotate-90">▸</span></span>
            </summary>
            <div className="mt-3 grid grid-cols-2 gap-2">
              <StatCard label="已接觸" value={String(data.statusCounts.total)} />
              <StatCard label={STATUS_LABELS.learning} value={String(data.statusCounts.learning)} />
              <StatCard label={STATUS_LABELS.mastered} value={String(data.statusCounts.mastered)} />
              <StatCard label={STATUS_LABELS.struggling} value={String(data.statusCounts.struggling)} />
            </div>
          </details>

          <details className="group rounded-2xl border border-border bg-surface p-4">
            <summary className="flex min-h-11 cursor-pointer list-none items-center justify-between gap-3 text-sm font-medium text-foreground marker:content-none [&::-webkit-details-marker]:hidden">
              <span>分項能力狀態</span><span aria-hidden="true" className="text-foreground-muted transition-transform group-open:rotate-90">▸</span>
            </summary>
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
          </details>

          <details className="group rounded-2xl border border-border bg-surface p-4">
            <summary className="flex min-h-11 cursor-pointer list-none items-center justify-between gap-3 text-sm font-medium text-foreground marker:content-none [&::-webkit-details-marker]:hidden">
              <span>近期表現</span><span aria-hidden="true" className="text-foreground-muted transition-transform group-open:rotate-90">▸</span>
            </summary>
            <div className="mt-3 grid grid-cols-2 gap-2">
              <StatCard
                label="近 7 日正確率"
                value={data.accuracy.sampleSize > 0 ? `${data.accuracy.accuracyPercent}%` : "—"}
                hint={data.accuracy.sampleSize > 0 ? `依 ${data.accuracy.sampleSize} 筆作答計算` : "近 7 天無作答紀錄"}
              />
              <StatCard label="待複習（已到期）" value={String(data.dueCount)} />
            </div>
          </details>

          <section aria-labelledby="vocabulary-heading" className="rounded-2xl border border-border bg-surface p-4">
            <div className="flex items-baseline justify-between gap-3">
              <h2 id="vocabulary-heading" className="text-base font-semibold text-foreground">我的單字庫</h2>
              <span className="text-xs tabular-nums text-foreground-muted">{filteredItems.length} / {data.items.length} 字</span>
            </div>

            {data.items.length === 0 ? (
              <div className="mt-4">
                <EmptyState
                  title="目前沒有日文單字"
                  description="新增單字後，就能在這裡查看。"
                  action={<Link href="/add" className="inline-block rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground">新增單字</Link>}
                />
              </div>
            ) : (
              <>
                <label htmlFor="vocabulary-search" className="sr-only">搜尋單字</label>
                <input
                  id="vocabulary-search"
                  type="search"
                  value={search}
                  onChange={(event) => { setSearch(event.target.value); setVisibleCount(PAGE_SIZE); }}
                  placeholder="搜尋日文、讀音或中文…"
                  className="mt-4 min-h-11 w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm text-foreground"
                />
                <div role="group" aria-label="單字狀態篩選" className="mt-3 flex flex-wrap gap-2">
                  {STATUS_FILTERS.map((filter) => (
                    <button
                      key={filter.value}
                      type="button"
                      aria-pressed={statusFilter === filter.value}
                      onClick={() => { setStatusFilter(filter.value); setVisibleCount(PAGE_SIZE); }}
                      className={`min-h-10 rounded-full border px-3 py-2 text-xs font-medium transition-colors ${statusFilter === filter.value ? "border-primary bg-primary text-primary-foreground" : "border-border text-foreground hover:bg-surface-muted"}`}
                    >
                      {filter.label}
                    </button>
                  ))}
                </div>

                {filteredItems.length === 0 ? (
                  <div className="mt-4"><EmptyState title="找不到符合條件的單字" description="試試其他關鍵字或狀態。" /></div>
                ) : (
                  <ul className="mt-4 flex flex-col gap-2">
                    {visibleItems.map((item) => (
                      <li key={item.id}>
                        <details className="group rounded-lg border border-border px-3 py-2">
                          <summary className="flex min-h-11 cursor-pointer list-none flex-col justify-center marker:content-none [&::-webkit-details-marker]:hidden">
                            <div className="flex items-center justify-between gap-2">
                              <span className="min-w-0 break-words text-sm font-semibold text-foreground">{item.answer}{item.reading && item.reading !== item.answer ? <span className="ml-2 font-normal text-foreground-muted">{item.reading}</span> : null}</span>
                              <span className="shrink-0 text-xs text-foreground-muted">{item.status === "new" ? "未學習" : STATUS_LABELS[item.status]} <span aria-hidden="true" className="inline-block transition-transform group-open:rotate-90">▸</span></span>
                            </div>
                            <p className="mt-0.5 text-xs text-foreground-muted">{item.promptZh}</p>
                          </summary>
                          <dl className="mt-3 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 border-t border-border pt-3 text-xs text-foreground">
                            {item.reading ? <><dt className="text-foreground-muted">讀音</dt><dd>{item.reading}</dd></> : null}
                            {item.explanation ? <><dt className="text-foreground-muted">說明</dt><dd>{item.explanation}</dd></> : null}
                            {item.partOfSpeech ? <><dt className="text-foreground-muted">詞性</dt><dd>{item.partOfSpeech}</dd></> : null}
                            {item.exampleSentence ? <><dt className="text-foreground-muted">例句</dt><dd>{item.exampleSentence}</dd></> : null}
                            <dt className="text-foreground-muted">來源</dt><dd>{item.isSeed ? "系統範例" : SOURCE_LABELS[item.source]}</dd>
                            {item.tags.length > 0 ? <><dt className="text-foreground-muted">標籤</dt><dd>{item.tags.join("、")}</dd></> : null}
                          </dl>
                        </details>
                      </li>
                    ))}
                  </ul>
                )}

                {visibleCount < filteredItems.length ? (
                  <button
                    type="button"
                    onClick={() => setVisibleCount((count) => count + PAGE_SIZE)}
                    className="mt-4 min-h-11 w-full rounded-lg border border-border px-3 py-2 text-sm font-medium text-foreground hover:bg-surface-muted"
                  >
                    顯示更多
                  </button>
                ) : null}
              </>
            )}
          </section>
        </>
      )}
    </main>
  );
}
