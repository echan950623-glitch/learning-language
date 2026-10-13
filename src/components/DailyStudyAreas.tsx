"use client";

import Link from "next/link";
import { createDailyAreaPlan, dailyAreaUnits } from "@/domain/dailyStudyAreas";
import { learningDay } from "@/domain/learningRules";
import type { Language } from "@/domain/types";
import { getRepository } from "@/repository";
import { usePracticeData } from "./PracticeLauncher";
import { AbandonPracticeButton } from "./AbandonPracticeButton";

export function DailyStudyAreas({ language }: { language: Language }) {
  const { data, error } = usePracticeData(language);
  const now = new Date();
  const plan = data ? createDailyAreaPlan(data.items, data.schedules, now, getRepository().listDailyPlans().find(p => p.language === language && p.date === learningDay(now)), data.attempts, language) : undefined;
  const newUnits = plan ? dailyAreaUnits(plan, "new") : [];
  const reviews = plan ? dailyAreaUnits(plan, "review") : [];
  const remainingWords = new Set(newUnits.map(u => u.learningItemId)).size;
  const enrolledToday = plan ? plan.newItemIds.filter(id => data?.items.some(i => i.id === id && i.introducedAt)).length : 0;
  const session = data?.session;
  return <section aria-labelledby={`${language}-daily-study`} className="rounded-2xl border border-border bg-surface p-4">
    <h2 id={`${language}-daily-study`} className="mb-3 font-semibold text-foreground">今日學習</h2>
    <div className="grid grid-cols-2 gap-3">
      {([{ area: "new", title: "新字", description: "每天最多 50 個新字", count: !data ? "載入進度…" : `${remainingWords} 個待學`, label: "開始學新字", available: remainingWords > 0 },
        { area: "review", title: "複習", description: "到期與待補強內容全部列入", count: !data ? "載入進度…" : `${reviews.length} 題待複習`, label: "開始複習", available: reviews.length > 0 }] as const).map(card =>
        <article key={card.area} className="flex min-w-0 flex-col gap-2 rounded-xl border border-border bg-background p-3">
          <h3 className="text-lg font-semibold text-foreground">{card.title}</h3>
          <p className="text-xs leading-5 text-foreground-muted">{card.description}</p>
          <p className="text-sm font-medium text-foreground">{card.count}</p>
          <p className="text-xs text-foreground-muted">{card.area === "new" ? `今日已引入 ${enrolledToday} / 50 個` : "不限題數，可中途離開後繼續"}</p>
          <div className="mt-auto pt-2">
            {data && card.available && !session ? <Link href={`/study?language=${language}&area=${card.area}`} className="block min-h-12 rounded-xl bg-primary px-2 py-3 text-center text-sm font-semibold text-primary-foreground">{card.label}</Link> :
              <button type="button" disabled className="min-h-12 w-full rounded-xl bg-primary px-2 py-3 text-sm font-semibold text-primary-foreground opacity-40">{session ? "先繼續目前練習" : !data ? "載入中…" : card.area === "new" ? "目前沒有新字" : "目前無待複習"}</button>}
          </div>
        </article>)}
    </div>
    {session ? <div className="mt-3">
      <p className="mb-2 text-sm text-foreground-muted">有尚未完成的練習：已完成 {session.exerciseResults.length} / {session.plannedUnits.length} 題。</p>
      <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,0.65fr)] gap-2">
        <Link href={`/study?language=${language}`} className="block min-h-12 rounded-xl bg-primary px-3 py-3 text-center text-sm font-semibold text-primary-foreground">繼續上次練習</Link>
        <AbandonPracticeButton key={session.id} sessionId={session.id} language={language} />
      </div>
    </div> : null}
    {data && !remainingWords && !enrolledToday ? <p className="mt-3 text-xs leading-5 text-foreground-muted">尚無可安排的新字時，請先在 GPT 預覽並確認加入教材。</p> : null}
    {error ? <p role="alert" className="mt-3 text-sm text-danger">{error}</p> : null}
    <p className="mt-3 text-xs leading-5 text-foreground-muted">新字與複習分開出題；未到期內容不會反覆排入複習。新字不足 50 個時，按實際內容安排。</p>
    <p className="mt-2 text-xs leading-5 text-foreground-muted">複習間隔：隔天確認 → 3 → 5 → 7 → 14 天；各階段無提示首答通過後，熟練內容退出日常複習。</p>
  </section>;
}
