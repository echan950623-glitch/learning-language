"use client";

import Link from "next/link";
import { createDailyAreaPlan, dailyAreaUnits, NEW_WORD_BATCH_SIZE } from "@/domain/dailyStudyAreas";
import { readDailyNewItemCap } from "@/lib/studyPreferences";
import { learningDay } from "@/domain/learningRules";
import type { Language } from "@/domain/types";
import { getRepository } from "@/repository";
import { usePracticeData } from "./PracticeLauncher";
import { AbandonPracticeButton } from "./AbandonPracticeButton";

export function DailyStudyAreas({ language }: { language: Language }) {
  const { data, error } = usePracticeData(language);
  const now = new Date();
  // Saved preferences live in browser storage, so they are read only after the account data has loaded.
  const cap = data ? readDailyNewItemCap() : undefined;
  const plan = data ? createDailyAreaPlan(data.items, data.schedules, now, getRepository().listDailyPlans().find(p => p.language === language && p.date === learningDay(now)), data.attempts, language, cap) : undefined;
  const newUnits = plan ? dailyAreaUnits(plan, "new") : [];
  const reviews = plan ? dailyAreaUnits(plan, "review") : [];
  const remainingWords = new Set(newUnits.map(u => u.learningItemId)).size;
  const enrolledToday = plan ? plan.newItemIds.filter(id => data?.items.some(i => i.id === id && i.introducedAt)).length : 0;
  const session = data?.session;
  const cards = [
    { area: "new", title: "新字", count: remainingWords, unit: "個待學", note: cap === undefined ? "載入進度…" : `今日已引入 ${enrolledToday} / ${Math.max(cap, plan?.newItemIds.length ?? 0)}，每輪約 ${NEW_WORD_BATCH_SIZE} 個`, label: "開始學新字", empty: "目前沒有新字" },
    { area: "review", title: "複習", count: reviews.length, unit: "題待複習", note: "到期與待補強內容，可中途離開", label: "開始複習", empty: "目前無待複習" },
  ] as const;
  // The first area with work gets the solid button, so the screen has a single obvious next step.
  const primaryArea = cards.find(card => card.count > 0)?.area;
  return <section aria-labelledby={`${language}-daily-study`}>
    <h2 id={`${language}-daily-study`} className="eyebrow">今日學習</h2>
    <div className="mt-3 border-t border-border">
      {cards.map(card =>
        <article key={card.area} className="border-b border-border py-5">
          <div className="flex items-end justify-between gap-4">
            <div className="min-w-0">
              <h3 className="text-lg font-medium text-foreground">{card.title}</h3>
              <p className="mt-1 text-xs leading-5 text-foreground-muted">{card.note}</p>
            </div>
            <p className="shrink-0 text-right">
              <span className="block font-display text-5xl font-medium leading-none tabular-nums text-foreground">{data ? card.count : "–"}</span>
              <span className="mt-1 block text-xs text-foreground-muted">{card.unit}</span>
            </p>
          </div>
          <div className="mt-4">
            {data && card.count > 0 && !session ? <Link href={`/study?language=${language}&area=${card.area}`} className={`flex min-h-12 items-center justify-between rounded-xl px-4 text-sm font-semibold ${card.area === primaryArea ? "bg-primary text-primary-foreground" : "border border-foreground text-foreground"}`}><span>{card.label}</span><span aria-hidden="true">→</span></Link> :
              <button type="button" disabled className="min-h-12 w-full rounded-xl border border-border px-4 text-left text-sm text-foreground-muted">{session ? "先繼續目前練習" : !data ? "載入中…" : card.empty}</button>}
          </div>
        </article>)}
    </div>
    {session ? <div className="mt-5">
      <p className="mb-3 text-sm text-foreground-muted">有尚未完成的練習：已完成 {session.exerciseResults.length} / {session.plannedUnits.length} 題。</p>
      <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,0.65fr)] gap-2">
        <Link href={`/study?language=${language}`} className="flex min-h-12 items-center justify-between rounded-xl bg-primary px-4 text-sm font-semibold text-primary-foreground"><span>繼續上次練習</span><span aria-hidden="true">→</span></Link>
        <AbandonPracticeButton key={session.id} sessionId={session.id} language={language} />
      </div>
    </div> : null}
    {data && !remainingWords && !enrolledToday ? <p className="mt-4 text-xs leading-5 text-foreground-muted">尚無可安排的新字時，請先在 GPT 預覽並確認加入教材。</p> : null}
    {error ? <p role="alert" className="mt-3 text-sm text-danger">{error}</p> : null}
  </section>;
}
