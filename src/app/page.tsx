"use client";
import { EnglishHome } from "@/components/EnglishHome";
import Link from "next/link";
import { DailyStudyAreas } from "@/components/DailyStudyAreas";
import {
  PracticeStartButton,
  usePracticeData,
} from "@/components/PracticeLauncher";
import {
  PRACTICE_CATEGORIES,
  learnedPracticeItems,
} from "@/domain/practiceSelection";
import { selectHomeLanguage, useHomeLanguage } from "@/lib/homeLanguage";
export default function HomePage() {
  const language = useHomeLanguage();
  return (
    <main className="mx-auto flex w-[94%] max-w-xl flex-1 flex-col gap-5 py-6">
      <div role="group" aria-label="學習語言" className="grid grid-cols-2 gap-1 rounded-xl border border-border bg-surface p-1">
        {([{ id: "ja", label: "日文" }, { id: "en", label: "英文" }] as const).map((option) => (
          <button
            key={option.id}
            type="button"
            aria-pressed={language === option.id}
            onClick={() => selectHomeLanguage(option.id)}
            className={`min-h-12 rounded-lg px-4 py-3 font-semibold transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary ${language === option.id ? "bg-primary text-primary-foreground" : "text-foreground-muted hover:bg-background hover:text-foreground"}`}
          >
            {option.label}
          </button>
        ))}
      </div>
      {language === "ja" ? <JapaneseHome /> : <EnglishHome />}
    </main>
  );
}

function JapaneseHome() {
  const { data, error } = usePracticeData();
  return (
    <div className="flex flex-col gap-5">
      <header>
        <h1 className="text-2xl font-semibold text-foreground">日文學習</h1>
        <p className="mt-1 text-sm text-foreground-muted">
          直接開始，系統會安排需要補強與到期驗證的內容。
        </p>
      </header>
      {error ? (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      ) : null}
      <DailyStudyAreas language="ja" />
      <section aria-labelledby="choose-practice">
        <h2 id="choose-practice" className="mb-3 font-semibold text-foreground">
          今天想練什麼？
        </h2>
        <div className="grid grid-cols-2 gap-3">
          {PRACTICE_CATEGORIES.map((c) => (
            <article
              key={c.id}
              className="flex min-w-0 flex-col gap-3 rounded-2xl border border-border bg-surface p-3"
            >
              <div>
                <h3 className="font-semibold text-foreground">{c.label}</h3>
                <p className="mt-1 text-xs leading-5 text-foreground-muted">
                  {c.description}
                </p>
              </div>
              <p className="text-xs text-foreground-muted">
                {data
                  ? `${learnedPracticeItems(data.items, data.attempts, data.schedules, c.id).length} 項可練`
                  : "載入中…"}
              </p>
              <div className="mt-auto">
                <PracticeStartButton category={c.id} compact />
                <Link
                  href={`/practice?category=${c.id}`}
                  className="mt-1 block min-h-11 py-3 text-center text-xs font-medium text-primary"
                >
                  選練習範圍 ›
                </Link>
              </div>
            </article>
          ))}
        </div>
      </section>
      <p className="text-xs leading-5 text-foreground-muted">
        尚無內容的類別，請告訴 GPT
        你想練什麼。新單字先從今日複習開始；自主練習不會反覆延長間隔。
      </p>
    </div>
  );
}
