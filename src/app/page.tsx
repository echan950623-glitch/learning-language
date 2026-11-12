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
    <main className="mx-auto flex w-[88%] max-w-xl flex-1 flex-col gap-10 pb-10 pt-6">
      <div role="group" aria-label="學習語言" className="flex gap-6 border-b border-border">
        {([{ id: "ja", label: "日文" }, { id: "en", label: "英文" }] as const).map((option) => (
          <button
            key={option.id}
            type="button"
            aria-pressed={language === option.id}
            onClick={() => selectHomeLanguage(option.id)}
            className={`-mb-px min-h-12 border-b-2 px-1 text-sm tracking-wide transition-colors ${language === option.id ? "border-foreground font-semibold text-foreground" : "border-transparent text-foreground-muted hover:text-foreground"}`}
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
    <div className="flex flex-col gap-12">
      <header>
        <p className="eyebrow">Japanese</p>
        <h1 className="mt-2 font-display text-4xl font-medium tracking-tight text-foreground">日文學習</h1>
      </header>
      {error ? (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      ) : null}
      <DailyStudyAreas language="ja" />
      <section aria-labelledby="choose-practice">
        <h2 id="choose-practice" className="eyebrow">
          自主練習
        </h2>
        <ul className="mt-3 border-t border-border">
          {PRACTICE_CATEGORIES.map((c) => {
            const count = data ? learnedPracticeItems(data.items, data.attempts, data.schedules, c.id).length : undefined;
            return (
              <li key={c.id} className={`flex items-center gap-3 border-b border-border py-3 ${count === 0 ? "opacity-55" : ""}`}>
                <Link href={`/practice?category=${c.id}`} className="min-w-0 flex-1 py-1">
                  <h3 className="font-medium text-foreground">{c.label}</h3>
                  <p className="mt-0.5 truncate text-xs text-foreground-muted">
                    {c.description}
                  </p>
                </Link>
                <p className="shrink-0 text-xs tabular-nums text-foreground-muted">
                  {count === undefined ? "…" : count === 0 ? "尚無內容" : `${count} 項`}
                </p>
                {count ? <div className="w-20 shrink-0"><PracticeStartButton category={c.id} label="練習" compact /></div> : null}
              </li>
            );
          })}
        </ul>
        <p className="mt-4 text-xs leading-5 text-foreground-muted">
          點類別名稱可選練習範圍。尚無內容的類別，請告訴 GPT 你想練什麼。
        </p>
      </section>
    </div>
  );
}
