"use client";
import { useState, type FormEvent } from "react";
import type { LearningItem, LearningItemEdit } from "@/domain/types";
import { describePersistenceError, mutateRepository } from "@/repository";

export function LearningItemEditor({ item }: { item: LearningItem }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<LearningItemEdit>({ promptZh: item.promptZh, answer: item.answer, reading: item.reading,
    explanation: item.explanation, partOfSpeech: item.partOfSpeech, exampleSentence: item.exampleSentence, acceptedAnswers: item.acceptedAnswers, answerFormat: item.answerFormat ?? "vocabulary" });
  const [error, setError] = useState<string | null>(null);
  const [acceptedText, setAcceptedText] = useState(item.acceptedAnswers?.join("、") ?? "");
  const [saving, setSaving] = useState(false);
  async function save(event: FormEvent) {
    event.preventDefault();
    if (saving) return;
    setSaving(true); setError(null);
    try { await mutateRepository(repository => repository.editItem(item.id, item.contentVersion ?? 1, { ...draft, acceptedAnswers: acceptedText.split(/[,、]/).map(answer => answer.trim()).filter(Boolean) }, new Date())); setEditing(false); }
    catch (error) { setError(describePersistenceError(error)); }
    finally { setSaving(false); }
  }
  if (!editing) return <button type="button" onClick={() => setEditing(true)} className="mt-3 min-h-11 rounded-lg border border-border px-3 py-2 text-sm text-foreground">編輯單字</button>;
  const fields = [ ["promptZh", "這個具體詞義／情境"], ["answer", "日文答案"], ["reading", "讀音"], ["partOfSpeech", "詞性"], ["exampleSentence", "短例句"], ["explanation", "關鍵說明"] ] as const;
  return <form onSubmit={save} className="mt-4 flex flex-col gap-3 border-t border-border pt-4">
    {fields.map(([key,label]) => <label key={key} className="flex flex-col gap-1 text-sm text-foreground">{label}
      <input value={draft[key] ?? ""} required={key === "promptZh" || key === "answer"} onChange={event => setDraft(draft => ({ ...draft, [key]: event.target.value }))}
        className="min-h-11 rounded-lg border border-border bg-surface px-3 py-2 text-foreground" />
    </label>)}
    <label className="flex flex-col gap-1 text-sm text-foreground">其他可接受答案（以逗號分隔）
      <input value={acceptedText} onChange={event => setAcceptedText(event.target.value)} className="min-h-11 rounded-lg border border-border bg-surface px-3 py-2" />
    </label>
    <label className="flex gap-2 text-sm text-foreground"><input type="checkbox" checked={draft.answerFormat === "kanji"} onChange={event => setDraft(draft => ({ ...draft, answerFormat: event.target.checked ? "kanji" : "vocabulary" }))} />要求指定漢字寫法（仍是打字，不代表會手寫）</label>
    <p className="text-xs leading-5 text-foreground-muted">更改詞義、答案、讀音或可接受答案會建立新版本，要求重新理解並重建未來熟練度；既有作答與原题快照保留，進行中的題目維持原版本。</p>
    {error ? <p role="alert" className="text-sm text-danger">{error}</p> : null}
    <div className="flex gap-2"><button type="submit" disabled={saving} className="min-h-11 rounded-lg bg-primary px-4 py-2 text-primary-foreground">保存新版</button><button type="button" onClick={() => setEditing(false)} disabled={saving} className="min-h-11 rounded-lg border border-border px-4 py-2 text-foreground">取消</button></div>
  </form>;
}
