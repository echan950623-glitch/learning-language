"use client";
import { EnglishHome } from "@/components/EnglishHome";
import Link from "next/link";
import { DailyStudyAreas } from "@/components/DailyStudyAreas";
import { usePracticeData } from "@/components/PracticeLauncher";
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
  const { error } = usePracticeData();
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
      <Link href="/review" className="flex items-center gap-3 border-y border-border py-4">
        <span className="min-w-0 flex-1">
          <span className="block font-medium text-foreground">複習學過的內容</span>
          <span className="mt-0.5 block text-xs text-foreground-muted">混合複習、錯題與單項練習</span>
        </span>
        <span aria-hidden="true" className="text-foreground-muted">→</span>
      </Link>
    </div>
  );
}
