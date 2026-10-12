"use client";
import Link from "next/link";
import { EnglishHome } from "@/components/EnglishHome";
import { AbandonPracticeButton } from "@/components/AbandonPracticeButton";
import {
  PracticeStartButton,
  usePracticeData,
} from "@/components/PracticeLauncher";
import {
  PRACTICE_CATEGORIES,
  learnedPracticeItems,
} from "@/domain/practiceSelection";
import { limitVerificationUnits } from "@/domain/automaticVerification";
import { createDailyPlan, learningDay } from "@/domain/learningRules";
import { getRepository } from "@/repository";
import { readBusyMode, readDailyNewItemCap, readStudyQuestionCount } from "@/lib/studyPreferences";
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
  const now = new Date();
  const plan = data
    ? createDailyPlan(
        data.items,
        data.schedules,
        now,
        readDailyNewItemCap(),
        readBusyMode(),
        getRepository()
          .listDailyPlans()
          .find((p) => p.language === "ja" && p.date === learningDay(now)),
        undefined, data.attempts,
      )
    : undefined;
  const remaining =
    plan?.units.filter(
      (u) =>
        !plan.completedUnitKeys.includes(`${u.learningItemId}:${u.ability}`),
    ).length ?? 0;
  const roundCount = plan && data ? limitVerificationUnits(plan.units.filter(u => !plan.completedUnitKeys.includes(`${u.learningItemId}:${u.ability}`)), data.items, data.schedules, data.attempts, plan.busy ? Math.min(5, readStudyQuestionCount()) : readStudyQuestionCount()).length : 0;
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
      <section className="rounded-2xl border border-border bg-surface p-4">
        <h2 className="font-semibold text-foreground">
          {data?.session ? "上次還沒練完" : "今日學習"}
        </h2>
        <p className="mt-2 text-sm text-foreground-muted">
          {!data
            ? "載入進度…"
            : data.session
              ? `已完成 ${data.session.exerciseResults.length} / ${data.session.plannedUnits.length} 題`
              : `這輪安排 ${roundCount} 題，系統已替你挑好。`}
        </p>
        {data && (data.session || remaining > 0) ? (
          <div
            className={`mt-3 ${data.session ? "grid grid-cols-[minmax(0,1fr)_minmax(0,0.65fr)] items-start gap-2" : ""}`}
          >
            <Link
              href="/study"
              className="block min-h-12 rounded-xl bg-primary px-4 py-3 text-center font-semibold text-primary-foreground"
            >
              {data.session ? "繼續上次練習" : "開始今日學習"}
            </Link>
            {data.session ? (
              <AbandonPracticeButton
                key={data.session.id}
                sessionId={data.session.id}
              />
            ) : null}
          </div>
        ) : (
          <p className="mt-3 text-sm text-foreground-muted">
            {data
              ? data.items.some((item) => !item.coachReport && !item.archivedAt)
                ? "目前沒有待安排的題目，仍可從下方選擇自主練習。"
                : "還沒有學習內容。請先在 GPT 預覽並確認加入，再回來開始。"
              : ""}
          </p>
        )}
        <p className="mt-2 text-xs leading-5 text-foreground-muted">
          熟悉的內容會減少出題，之後自動驗證；每輪最多兩題，不必自己挑。
        </p>
      </section>
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
