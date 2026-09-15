"use client";

import Link from "next/link";
import { useEffect, useRef, useState, type FormEvent } from "react";

import { describePersistenceError, getRepository } from "@/repository";
import type { ItemSource } from "@/domain/types";
import { SOURCE_LABELS, USER_SELECTABLE_SOURCES } from "@/lib/labels";

interface FormState {
  promptZh: string;
  answer: string;
  reading: string;
  explanation: string;
  source: ItemSource;
  tagsRaw: string;
}

const INITIAL_FORM: FormState = {
  promptZh: "",
  answer: "",
  reading: "",
  explanation: "",
  source: "manual",
  tagsRaw: "",
};

function parseTags(raw: string): string[] {
  return raw
    .split(/[,、]/)
    .map((tag) => tag.trim())
    .filter((tag) => tag.length > 0);
}

export default function AddItemPage() {
  const [form, setForm] = useState<FormState>(INITIAL_FORM);
  const [errors, setErrors] = useState<Partial<Record<keyof FormState, string>>>({});
  const [justAdded, setJustAdded] = useState<string | null>(null);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [seedCount, setSeedCount] = useState<number | null>(null);
  const [seedMessage, setSeedMessage] = useState<string | null>(null);
  const [seedError, setSeedError] = useState<string | null>(null);
  const promptRef = useRef<HTMLInputElement>(null);

  const refreshSeedCount = () => {
    const repository = getRepository();
    const items = repository.listItems({ language: "ja" });
    setSeedCount(items.filter((item) => item.isSeed).length);
  };

  useEffect(() => {
    refreshSeedCount();
  }, []);

  function validate(current: FormState): Partial<Record<keyof FormState, string>> {
    const nextErrors: Partial<Record<keyof FormState, string>> = {};
    if (!current.promptZh.trim()) nextErrors.promptZh = "請輸入中文提示";
    if (!current.answer.trim()) nextErrors.answer = "請輸入日文答案";
    if (!current.reading.trim()) nextErrors.reading = "請輸入假名讀音";
    return nextErrors;
  }

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const nextErrors = validate(form);
    setErrors(nextErrors);
    if (Object.keys(nextErrors).length > 0) {
      promptRef.current?.focus();
      return;
    }

    setIsSubmitting(true);
    setSubmitError(null);
    setJustAdded(null);

    const repository = getRepository();
    try {
      const created = repository.addItem({
        language: "ja",
        type: "vocabulary",
        promptZh: form.promptZh.trim(),
        answer: form.answer.trim(),
        reading: form.reading.trim(),
        explanation: form.explanation.trim() || undefined,
        source: form.source,
        tags: parseTags(form.tagsRaw),
        isSeed: false,
      });

      // R4：只有真的寫入成功才顯示「已新增」、清空表單。失敗時保留使用者輸入，
      // 不假裝成功，讓使用者可以直接重按送出重試。
      setJustAdded(created.answer);
      setForm(INITIAL_FORM);
      setErrors({});
      refreshSeedCount();
      promptRef.current?.focus();
    } catch (error) {
      setSubmitError(describePersistenceError(error));
    } finally {
      setIsSubmitting(false);
    }
  }

  function handleClearSeed() {
    const repository = getRepository();
    setSeedError(null);
    try {
      const removed = repository.removeSeedItems("ja");
      setSeedMessage(removed > 0 ? `已移除 ${removed} 個範例項目。` : "目前沒有範例項目可移除。");
      refreshSeedCount();
    } catch (error) {
      setSeedError(describePersistenceError(error));
    }
  }

  return (
    <main className="mx-auto flex max-w-md flex-1 flex-col gap-5 px-4 py-6">
      <header>
        <Link href="/" className="text-xs text-foreground-muted hover:text-foreground">
          ← 回首頁
        </Link>
        <h1 className="mt-1 text-xl font-semibold text-foreground">新增日文單字</h1>
        <p className="mt-1 text-sm text-foreground-muted">送出後會立即保存，並自動排入下次「今日學習」。</p>
      </header>

      {justAdded ? (
        <div role="status" className="rounded-xl bg-success-bg px-4 py-3 text-sm text-success">
          已新增「{justAdded}」。可以繼續新增，或到
          <Link href="/study" className="ml-1 underline underline-offset-2">
            今日學習
          </Link>
          查看。
        </div>
      ) : null}

      {submitError ? (
        <div role="alert" className="rounded-xl bg-danger-bg px-4 py-3 text-sm text-danger">
          新增失敗：{submitError}你剛剛輸入的內容還在下面表單裡，可以直接再按一次「新增這個字」重試。
        </div>
      ) : null}

      <form onSubmit={handleSubmit} noValidate className="flex flex-col gap-4">
        <div className="flex flex-col gap-1">
          <label htmlFor="promptZh" className="text-sm font-medium text-foreground">
            中文提示 <span aria-hidden="true">*</span>
          </label>
          <input
            id="promptZh"
            ref={promptRef}
            type="text"
            value={form.promptZh}
            onChange={(e) => setForm((f) => ({ ...f, promptZh: e.target.value }))}
            aria-invalid={Boolean(errors.promptZh)}
            aria-describedby={errors.promptZh ? "promptZh-error" : undefined}
            className="rounded-lg border border-border bg-surface px-3 py-2 text-sm text-foreground"
            placeholder="例如：謝謝"
          />
          {errors.promptZh ? (
            <p id="promptZh-error" className="text-xs text-danger">
              {errors.promptZh}
            </p>
          ) : null}
        </div>

        <div className="flex flex-col gap-1">
          <label htmlFor="answer" className="text-sm font-medium text-foreground">
            日文答案 <span aria-hidden="true">*</span>
          </label>
          <input
            id="answer"
            type="text"
            value={form.answer}
            onChange={(e) => setForm((f) => ({ ...f, answer: e.target.value }))}
            aria-invalid={Boolean(errors.answer)}
            aria-describedby={errors.answer ? "answer-error" : undefined}
            className="rounded-lg border border-border bg-surface px-3 py-2 text-sm text-foreground"
            placeholder="例如：ありがとう"
          />
          {errors.answer ? (
            <p id="answer-error" className="text-xs text-danger">
              {errors.answer}
            </p>
          ) : null}
        </div>

        <div className="flex flex-col gap-1">
          <label htmlFor="reading" className="text-sm font-medium text-foreground">
            假名讀音 <span aria-hidden="true">*</span>
          </label>
          <input
            id="reading"
            type="text"
            value={form.reading}
            onChange={(e) => setForm((f) => ({ ...f, reading: e.target.value }))}
            aria-invalid={Boolean(errors.reading)}
            aria-describedby={errors.reading ? "reading-error" : undefined}
            className="rounded-lg border border-border bg-surface px-3 py-2 text-sm text-foreground"
            placeholder="例如：ありがとう"
          />
          {errors.reading ? (
            <p id="reading-error" className="text-xs text-danger">
              {errors.reading}
            </p>
          ) : (
            <p className="text-xs text-foreground-muted">純假名的字，讀音可以跟答案填一樣。</p>
          )}
        </div>

        <div className="flex flex-col gap-1">
          <label htmlFor="explanation" className="text-sm font-medium text-foreground">
            簡短說明（可選）
          </label>
          <textarea
            id="explanation"
            value={form.explanation}
            onChange={(e) => setForm((f) => ({ ...f, explanation: e.target.value }))}
            rows={2}
            className="rounded-lg border border-border bg-surface px-3 py-2 text-sm text-foreground"
            placeholder="例如：用於道謝，比較口語"
          />
        </div>

        <div className="flex flex-col gap-1">
          <label htmlFor="source" className="text-sm font-medium text-foreground">
            來源
          </label>
          <select
            id="source"
            value={form.source}
            onChange={(e) => setForm((f) => ({ ...f, source: e.target.value as ItemSource }))}
            className="rounded-lg border border-border bg-surface px-3 py-2 text-sm text-foreground"
          >
            {USER_SELECTABLE_SOURCES.map((source) => (
              <option key={source} value={source}>
                {SOURCE_LABELS[source]}
              </option>
            ))}
          </select>
        </div>

        <div className="flex flex-col gap-1">
          <label htmlFor="tags" className="text-sm font-medium text-foreground">
            標籤（可選，用逗號分隔）
          </label>
          <input
            id="tags"
            type="text"
            value={form.tagsRaw}
            onChange={(e) => setForm((f) => ({ ...f, tagsRaw: e.target.value }))}
            className="rounded-lg border border-border bg-surface px-3 py-2 text-sm text-foreground"
            placeholder="例如：動詞, 第三課"
          />
        </div>

        <button
          type="submit"
          disabled={isSubmitting}
          className="rounded-xl bg-primary px-4 py-3 text-sm font-semibold text-primary-foreground transition-colors hover:opacity-90 disabled:opacity-50"
        >
          {isSubmitting ? "新增中…" : "新增這個字"}
        </button>
      </form>

      <section aria-labelledby="seed-management" className="rounded-xl border border-dashed border-border bg-surface-muted p-4">
        <h2 id="seed-management" className="text-sm font-medium text-foreground">
          範例資料管理
        </h2>
        <p className="mt-1 text-xs text-foreground-muted">
          {seedCount === null
            ? "載入中…"
            : seedCount > 0
              ? `目前有 ${seedCount} 個範例項目（非你自己新增的內容），可以移除。`
              : "目前沒有範例項目。"}
        </p>
        {seedCount !== null && seedCount > 0 ? (
          <button
            type="button"
            onClick={handleClearSeed}
            className="mt-2 rounded-lg border border-border px-3 py-1.5 text-xs font-medium text-foreground transition-colors hover:bg-surface"
          >
            清除範例資料
          </button>
        ) : null}
        {seedMessage ? (
          <p role="status" className="mt-2 text-xs text-foreground-muted">
            {seedMessage}
          </p>
        ) : null}
        {seedError ? (
          <p role="alert" className="mt-2 text-xs text-danger">
            清除失敗：{seedError}
          </p>
        ) : null}
      </section>
    </main>
  );
}
