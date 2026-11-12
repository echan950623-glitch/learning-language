"use client";
import Link from "next/link";
import { usePracticeData } from "./PracticeLauncher";
import { readStudyQuestionCount } from "@/lib/studyPreferences";
import { DailyStudyAreas } from "./DailyStudyAreas";
import { ENGLISH_PRACTICE_CATEGORIES, learnedEnglishPracticeItems } from "@/domain/englishPracticeSelection";
import { EnglishPracticeStartButton } from "./EnglishPracticeStartButton";

export function EnglishHome() {
  const { data, error } = usePracticeData("en");
  return <div className="flex flex-col gap-12">
    <header><p className="eyebrow">English</p><h1 className="mt-2 font-display text-4xl font-medium tracking-tight text-foreground">英文學習</h1><p className="mt-3 text-sm leading-6 text-foreground-muted">累積單字與片語，逐步看懂日常、職場與技術英文。</p></header>
    {error ? <p role="alert" className="text-danger">{error}</p> : null}
    <DailyStudyAreas language="en" />
    <section aria-labelledby="choose-english-practice">
      <h2 id="choose-english-practice" className="eyebrow">自主練習</h2>
      <ul className="mt-3 border-t border-border">
        {ENGLISH_PRACTICE_CATEGORIES.map(category => {
          const count = category.id === "toeic" ? 0 : data ? learnedEnglishPracticeItems(data.items, data.attempts, data.schedules, category.id).length : undefined;
          return <li key={category.id} className={`flex items-center gap-3 border-b border-border py-3 ${count === 0 ? "opacity-55" : ""}`}>
            <Link href={`/practice/english?category=${category.id}`} className="min-w-0 flex-1 py-1">
              <h3 className="font-medium text-foreground">{category.label}</h3>
              <p className="mt-0.5 truncate text-xs text-foreground-muted">{category.description}</p>
            </Link>
            <p className="shrink-0 text-xs tabular-nums text-foreground-muted">{count === undefined ? "…" : count === 0 ? "尚無內容" : `${count} 項`}</p>
            {count ? <div className="w-20 shrink-0"><EnglishPracticeStartButton selection={{ category: category.id, source: "all", questionCount: readStudyQuestionCount() }} compact /></div> : null}
          </li>;
        })}
      </ul>
      <p className="mt-4 text-xs leading-5 text-foreground-muted">點類別名稱可選練習範圍。新單字與片語先從今日學習開始。</p>
    </section>
    <Link href="/progress?language=en" className="flex min-h-12 items-center justify-between rounded-xl border border-foreground px-4 text-sm font-semibold text-foreground"><span>查看單字與片語</span><span aria-hidden="true">→</span></Link>
  </div>;
}
