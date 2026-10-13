"use client";

import { useEffect, useState } from "react";

import {
  DEFAULT_STUDY_QUESTION_COUNT,
  readStudyQuestionCount,
  saveStudyQuestionCount,
  STUDY_QUESTION_COUNT_OPTIONS,
  type StudyQuestionCount,
} from "@/lib/studyPreferences";
import { withDataLock, subscribeDataChanged } from "@/repository/accountStorage";
import { MigrationPanel } from "@/components/MigrationPanel";
import { DataSafetyPanel } from "@/components/DataSafetyPanel";
import { AccountSyncPanel } from "@/components/AccountSyncPanel";

export default function SettingsPage() {
  const [selected, setSelected] = useState<StudyQuestionCount>(DEFAULT_STUDY_QUESTION_COUNT);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const refresh = () => {
    setSelected(readStudyQuestionCount());
    };
    refresh();
    return subscribeDataChanged(refresh);
  }, []);

  async function handleChange(count: StudyQuestionCount) {
    setMessage(null);
    setError(null);
    try {
      await withDataLock(() => saveStudyQuestionCount(count));
      setSelected(count);
      setMessage(`已設定自主練習每輪 ${count} 題，下一輪生效。`);
    } catch {
      setError("設定沒有保存，請確認瀏覽器允許本機儲存後再試一次。");
    }
  }

  return (
    <main className="mx-auto flex w-[94%] max-w-xl flex-1 flex-col gap-5 py-6">
      <header>
        <h1 className="text-xl font-semibold text-foreground">學習設定</h1>
        <p className="mt-1 text-sm text-foreground-muted">調整自主練習的題數；新字與到期複習分開安排。</p>
      </header>

      <AccountSyncPanel />
      <MigrationPanel />
      <DataSafetyPanel />

      <section aria-labelledby="question-count" className="rounded-2xl border border-border bg-surface p-4">
        <h2 id="question-count" className="text-sm font-medium text-foreground">
          自主練習每輪題數
        </h2>
        <p className="mt-1 text-xs leading-5 text-foreground-muted">
          主題練習、錯題與總複習共用這個題數。首頁的新字專區每天最多 50 個，複習專區列出全部待複習內容，不受此設定限制。進行中的學習不會被中途改變。
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
        <h2 id="new-item-cap" className="text-sm font-medium text-foreground">新字與複習安排</h2>
        <p className="mt-2 text-sm leading-6 text-foreground-muted">新字專區每天最多 50 個，各語言分開計算；重新整理或跨輪不會重置今日額度。補讀音不重複計算新字。</p>
        <p className="mt-2 text-sm leading-6 text-foreground-muted">複習專區列出所有到期與待補強內容，不限題數；可中途離開，之後繼續。</p>
        <p className="mt-2 text-sm leading-6 text-foreground-muted">新字隔天確認，之後依上次通過時間間隔 3、5、7、14 天複習。無提示首答正確才前進；提示後答對保留階段，答錯重設，兩者都隔天再確認。熟練後退出日常出題。</p>
        <p className="mt-2 text-xs text-foreground-muted">學習時區為 Asia/Taipei，每日 00:00 換日；進行中的題目維持原計畫。</p>
      </section>
    </main>
  );
}
