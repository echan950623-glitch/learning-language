"use client";

import { useEffect, useState } from "react";

import {
  DEFAULT_STUDY_QUESTION_COUNT,
  readStudyQuestionCount,
  saveStudyQuestionCount,
  STUDY_QUESTION_COUNT_OPTIONS,
  type StudyQuestionCount,
} from "@/lib/studyPreferences";

export default function SettingsPage() {
  const [selected, setSelected] = useState<StudyQuestionCount>(DEFAULT_STUDY_QUESTION_COUNT);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => setSelected(readStudyQuestionCount()), []);

  function handleChange(count: StudyQuestionCount) {
    setMessage(null);
    setError(null);
    try {
      saveStudyQuestionCount(count);
      setSelected(count);
      setMessage(`已設定為每次 ${count} 題，下一次開始學習時生效。`);
    } catch {
      setError("設定沒有保存，請確認瀏覽器允許本機儲存後再試一次。");
    }
  }

  return (
    <main className="mx-auto flex w-[94%] max-w-xl flex-1 flex-col gap-5 py-6">
      <header>
        <h1 className="text-xl font-semibold text-foreground">學習設定</h1>
        <p className="mt-1 text-sm text-foreground-muted">調整下一次「今日學習」或自主複習要完成的總題數。</p>
      </header>

      <section aria-labelledby="question-count" className="rounded-2xl border border-border bg-surface p-4">
        <h2 id="question-count" className="text-sm font-medium text-foreground">
          每次學習題數
        </h2>
        <p className="mt-1 text-xs leading-5 text-foreground-muted">
          今日學習會先排到期複習，再加入新單字；錯題與總複習也共用這個題數。進行中的學習不會被中途改變。
        </p>

        <div className="mt-4 grid grid-cols-2 gap-3" role="radiogroup" aria-labelledby="question-count">
          {STUDY_QUESTION_COUNT_OPTIONS.map((count) => {
            const active = selected === count;
            return (
              <button
                key={count}
                type="button"
                role="radio"
                aria-checked={active}
                onClick={() => handleChange(count)}
                className={`min-h-12 rounded-xl border px-4 py-3 text-sm font-semibold transition-colors ${
                  active
                    ? "border-primary bg-primary text-primary-foreground"
                    : "border-border bg-surface text-foreground hover:bg-surface-muted"
                }`}
              >
                {count} 題
              </button>
            );
          })}
        </div>

        {message ? <p role="status" className="mt-3 text-xs text-success">{message}</p> : null}
        {error ? <p role="alert" className="mt-3 text-xs text-danger">{error}</p> : null}
      </section>
    </main>
  );
}
