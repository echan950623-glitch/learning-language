"use client";

import { useEffect, useState } from "react";

import {
  DAILY_NEW_ITEM_CAP_OPTIONS,
  DEFAULT_DAILY_NEW_ITEM_CAP,
  DEFAULT_STUDY_QUESTION_COUNT,
  readDailyNewItemCap,
  readStudyQuestionCount,
  saveDailyNewItemCap,
  saveStudyQuestionCount,
  STUDY_QUESTION_COUNT_OPTIONS,
  type DailyNewItemCap,
  type StudyQuestionCount,
} from "@/lib/studyPreferences";
import { MigrationPanel } from "@/components/MigrationPanel";
import { AccountSyncPanel } from "@/components/AccountSyncPanel";

export default function SettingsPage() {
  const [selected, setSelected] = useState<StudyQuestionCount>(DEFAULT_STUDY_QUESTION_COUNT);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [newItemCap, setNewItemCap] = useState<DailyNewItemCap>(DEFAULT_DAILY_NEW_ITEM_CAP);
  const [newItemCapMessage, setNewItemCapMessage] = useState<string | null>(null);
  const [newItemCapError, setNewItemCapError] = useState<string | null>(null);

  useEffect(() => {
    setSelected(readStudyQuestionCount());
    setNewItemCap(readDailyNewItemCap());
  }, []);

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

  function handleNewItemCapChange(cap: DailyNewItemCap) {
    setNewItemCapMessage(null);
    setNewItemCapError(null);
    try {
      saveDailyNewItemCap(cap);
      setNewItemCap(cap);
      setNewItemCapMessage(`已設定為每天最多引入 ${cap} 個新項目，下一次開始學習時生效。`);
    } catch {
      setNewItemCapError("設定沒有保存，請確認瀏覽器允許本機儲存後再試一次。");
    }
  }

  return (
    <main className="mx-auto flex w-[94%] max-w-xl flex-1 flex-col gap-5 py-6">
      <header>
        <h1 className="text-xl font-semibold text-foreground">學習設定</h1>
        <p className="mt-1 text-sm text-foreground-muted">調整下一次「今日學習」或自主複習要完成的總題數。</p>
      </header>

      <AccountSyncPanel />
      <MigrationPanel />

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

      <section aria-labelledby="new-item-cap" className="rounded-2xl border border-border bg-surface p-4">
        <h2 id="new-item-cap" className="text-sm font-medium text-foreground">
          每日新字上限
        </h2>
        <p className="mt-1 text-xs leading-5 text-foreground-muted">
          控制「今日學習」一次最多引入幾個全新項目；到期複習不受這個上限影響，一律優先排入。
        </p>

        <div className="mt-4 grid grid-cols-3 gap-3" role="radiogroup" aria-labelledby="new-item-cap">
          {DAILY_NEW_ITEM_CAP_OPTIONS.map((cap) => {
            const active = newItemCap === cap;
            return (
              <button
                key={cap}
                type="button"
                role="radio"
                aria-checked={active}
                onClick={() => handleNewItemCapChange(cap)}
                className={`min-h-12 rounded-xl border px-4 py-3 text-sm font-semibold transition-colors ${
                  active
                    ? "border-primary bg-primary text-primary-foreground"
                    : "border-border bg-surface text-foreground hover:bg-surface-muted"
                }`}
              >
                {cap} 個
              </button>
            );
          })}
        </div>

        {newItemCapMessage ? <p role="status" className="mt-3 text-xs text-success">{newItemCapMessage}</p> : null}
        {newItemCapError ? <p role="alert" className="mt-3 text-xs text-danger">{newItemCapError}</p> : null}
      </section>
    </main>
  );
}
