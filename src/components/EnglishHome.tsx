"use client";
import Link from "next/link";
import { usePracticeData } from "./PracticeLauncher";
import { readStudyQuestionCount } from "@/lib/studyPreferences";
import { DailyStudyAreas } from "./DailyStudyAreas";
import { ENGLISH_PRACTICE_CATEGORIES, learnedEnglishPracticeItems } from "@/domain/englishPracticeSelection";
import { EnglishPracticeStartButton } from "./EnglishPracticeStartButton";

export function EnglishHome() {
  const { data, error } = usePracticeData("en");
  return <div className="flex flex-col gap-5">
    <header><h1 className="text-2xl font-semibold text-foreground">英文學習</h1><p className="mt-1 text-sm text-foreground-muted">累積單字與片語，逐步看懂日常、職場與技術英文。</p></header>
    {error ? <p role="alert" className="text-danger">{error}</p> : null}
    <DailyStudyAreas language="en" />
    <section aria-labelledby="choose-english-practice">
      <h2 id="choose-english-practice" className="mb-3 font-semibold text-foreground">今天想練什麼？</h2>
      <div className="grid grid-cols-2 gap-3">
        {ENGLISH_PRACTICE_CATEGORIES.map(category => <article key={category.id} className="flex min-w-0 flex-col gap-3 rounded-2xl border border-border bg-surface p-3">
          <div><h3 className="font-semibold text-foreground">{category.label}</h3><p className="mt-1 text-xs leading-5 text-foreground-muted">{category.description}</p></div>
          <p className="text-xs text-foreground-muted">{category.id === "toeic" ? "目前尚無內容" : data ? `${learnedEnglishPracticeItems(data.items, data.attempts, data.schedules, category.id).length} 項可練` : "載入中…"}</p>
          <div className="mt-auto">
            {category.id !== "toeic" ? <EnglishPracticeStartButton selection={{ category: category.id, source: "all", questionCount: readStudyQuestionCount() }} compact /> : null}
            <Link href={`/practice/english?category=${category.id}`} className="mt-1 block min-h-11 py-3 text-center text-xs font-medium text-primary">{category.id === "toeic" ? "查看專區 ›" : "選練習範圍 ›"}</Link>
          </div>
        </article>)}
      </div>
      <p className="mt-3 text-xs leading-5 text-foreground-muted">新單字與片語先從今日學習開始；已學內容可依主題自主練習。</p>
    </section>
    <Link href="/progress?language=en" className="min-h-12 rounded-xl border border-border bg-surface px-4 py-3 text-center font-medium text-primary">查看單字與片語</Link>
  </div>;
}
