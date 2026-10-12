"use client";

import Link from "next/link";
import { useState } from "react";
import { ENGLISH_PRACTICE_CATEGORIES, selectEnglishPracticeUnits, type EnglishPracticeCategory } from "@/domain/englishPracticeSelection";
import type { PracticeSource } from "@/domain/practiceSelection";
import { selectHomeLanguage } from "@/lib/homeLanguage";
import { STUDY_QUESTION_COUNT_OPTIONS } from "@/lib/studyPreferences";
import { EnglishPracticeStartButton } from "./EnglishPracticeStartButton";
import { usePracticeData } from "./PracticeLauncher";

export function EnglishPracticePicker({ initialCategory }: { initialCategory: EnglishPracticeCategory }) {
  const { data, error } = usePracticeData("en");
  const [category, setCategory] = useState(initialCategory);
  const [source, setSource] = useState<PracticeSource>("all");
  const [questionCount, setQuestionCount] = useState(10);
  const selection = { category, source, questionCount };
  const selected = data ? selectEnglishPracticeUnits(data.items, data.attempts, data.schedules, selection, new Date(), () => 0.5) : undefined;
  const optionClass = (active: boolean) => `min-h-11 rounded-xl border px-3 text-sm ${active ? "border-primary bg-primary text-primary-foreground" : "border-border bg-surface text-foreground"}`;
  return <main className="mx-auto flex w-[94%] max-w-xl flex-1 flex-col gap-4 py-6">
    <Link href="/" onClick={() => selectHomeLanguage("en")} className="min-h-11 py-2 text-sm text-primary">‹ 英文首頁</Link>
    <h1 className="text-2xl font-semibold text-foreground">英文 · {ENGLISH_PRACTICE_CATEGORIES.find(c => c.id === category)?.label}</h1>
    <label className="text-sm text-foreground">練習主題
      <select value={category} onChange={e => setCategory(e.target.value as EnglishPracticeCategory)} className="mt-2 min-h-11 w-full rounded-xl border border-border bg-surface px-3 text-foreground">
        {ENGLISH_PRACTICE_CATEGORIES.map(c => <option key={c.id} value={c.id}>{c.label}</option>)}
      </select>
    </label>
    {error ? <p role="alert" className="text-sm text-danger">{error}</p> : null}
    {category === "toeic" ? <section className="rounded-2xl border border-border bg-surface p-4"><h2 className="font-semibold text-foreground">多益專區目前沒有內容</h2><p className="mt-2 text-sm leading-6 text-foreground-muted">多益主題練習準備中，先從單字或片語開始練習。</p></section> : <>
      <p className="text-sm leading-6 text-foreground-muted">{category === "phrase" ? "練習已學片語與固定搭配的指定詞義。" : "練習已學單字的指定詞義。"}新內容請先從今日學習開始。</p>
      <fieldset><legend className="mb-2 text-sm font-semibold text-foreground">題目來源</legend><div className="flex flex-wrap gap-2">
        {([["recommended", "優先複習"], ["due", "只做到期"], ["wrong", "錯題"], ["all", "全部已學"]] as const).map(([id, label]) => <button key={id} type="button" aria-pressed={source === id} onClick={() => setSource(id)} className={optionClass(source === id)}>{label}</button>)}
      </div></fieldset>
      <fieldset><legend className="mb-2 text-sm font-semibold text-foreground">每輪題數</legend><div className="flex flex-wrap gap-2">
        {STUDY_QUESTION_COUNT_OPTIONS.map(count => <button key={count} type="button" aria-pressed={questionCount === count} onClick={() => setQuestionCount(count)} className={optionClass(questionCount === count)}>{count}</button>)}
      </div></fieldset>
      <p className="text-sm text-foreground-muted">{!data ? "載入進度…" : selected?.total ? `範圍內 ${selected.total} 題；本輪安排 ${selected.units.length} 題。` : "尚無符合範圍的題目。可調整題目來源，或先完成今日學習。"}</p>
      <EnglishPracticeStartButton selection={selection} />
      <p className="text-xs leading-5 text-foreground-muted">沿用直接辨義與句中辨義題型；自主練習不會反覆延長複習間隔。</p>
    </>}
  </main>;
}
