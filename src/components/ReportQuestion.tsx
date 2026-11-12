"use client";
import { useState } from "react";
import type { LearningItem } from "@/domain/types";
import { describePersistenceError, mutateRepository } from "@/repository";
import { addQuestionReport } from "@/repository/questionReports";

/** Flags the question just answered. It only keeps that question out of later rounds on this device; the answer already given is untouched. */
export function ReportQuestion({ item }: { item: LearningItem }) {
  const practice = item.practice;
  const [open, setOpen] = useState(false);
  const [note, setNote] = useState("");
  const [done, setDone] = useState(false);
  const [error, setError] = useState("");
  if (!practice?.activeVariantId) return null;
  const { conceptKey, activeVariantId } = practice;

  async function submit() {
    setError("");
    try {
      await mutateRepository(() => addQuestionReport({ conceptKey, variantId: activeVariantId!, prompt: item.promptZh, answer: item.answer, note, at: new Date().toISOString() }));
      setDone(true);
      setOpen(false);
    } catch (caught) {
      setError(describePersistenceError(caught));
    }
  }

  if (done) return <p role="status" className="text-xs text-foreground-muted">已回報，之後不會再出這題。可到設定複製回報內容。</p>;
  if (!open) return <button type="button" onClick={() => setOpen(true)} className="min-h-11 self-start text-xs text-foreground-muted underline underline-offset-4">這題有問題</button>;
  return (
    <div className="flex flex-col gap-2">
      <label htmlFor="report-note" className="eyebrow">哪裡有問題？（選填）</label>
      <input id="report-note" value={note} onChange={event => setNote(event.target.value)} maxLength={300} placeholder="例如：答案也可以是…／題目日文不自然"
        className="rounded-none border-0 border-b border-foreground bg-transparent px-0 py-2 text-base text-foreground placeholder:text-foreground-muted focus-visible:border-accent focus-visible:outline-none" />
      <div className="flex gap-4">
        <button type="button" onClick={submit} className="min-h-11 text-sm font-semibold text-foreground underline underline-offset-4">送出回報</button>
        <button type="button" onClick={() => setOpen(false)} className="min-h-11 text-sm text-foreground-muted">取消</button>
      </div>
      {error ? <p role="alert" className="text-xs text-danger">{error}</p> : null}
    </div>
  );
}
