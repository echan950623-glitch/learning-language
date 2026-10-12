"use client";
import { useState, useRef, type FormEvent } from "react";
import type { LearningItem } from "@/domain/types";
import { CAPABILITY_LABELS, PRACTICE_KIND_LABELS, type LearningPractice, type PracticeVariant, practiceInput } from "@/domain/learningPractice";
import { mutateRepository, describePersistenceError } from "@/repository";

const blank = (): PracticeVariant => ({ id: crypto.randomUUID(), prompt: "", answer: "", acceptedAnswers: [], explanation: "" });
export function PracticeEditor({ item, onSaved }: { item?: LearningItem; onSaved?: () => void }) {
  const [draft, setDraft] = useState<LearningPractice>(() => structuredClone(item?.practice ?? { version: 1, kind: "grammar", conceptKey: "", title: "", capability: "production", learned: false, enabled: false, variants: [blank()] }));
  const [error, setError] = useState(""); const [saving, setSaving] = useState(false);
  const busy = useRef(false);
  const updateVariant = (index: number, values: Partial<PracticeVariant>) => setDraft(old => ({ ...old, variants: old.variants.map((variant, i) => i === index ? { ...variant, ...values } : variant) }));
  async function save(event: FormEvent) {
    event.preventDefault(); if (busy.current) return; busy.current = true; setSaving(true); setError("");
    try {
      const practice = { ...draft, conceptKey: draft.conceptKey.trim() || `custom:${item?.id ?? crypto.randomUUID()}`, activeVariantId: undefined };
      const input = practiceInput(practice);
      await mutateRepository(repository => item ? repository.editItem(item.id, item.contentVersion ?? 1, { promptZh: input.promptZh, answer: input.answer,
        explanation: input.explanation, acceptedAnswers: input.acceptedAnswers, reading: undefined, practice }, new Date()) : repository.addItemsIfMissing([input]));
      onSaved?.();
    } catch (error) { setError(describePersistenceError(error)); } finally { busy.current = false; setSaving(false); }
  }
  const control = "min-h-11 w-full rounded-lg border border-border bg-surface px-3 py-2 text-foreground";
  return <form onSubmit={save} className="flex flex-col gap-3">
    <label className="text-sm text-foreground">內容名稱<input required maxLength={160} className={control} value={draft.title} onChange={e => setDraft({ ...draft, title: e.target.value })} /></label>
    <div className="grid grid-cols-2 gap-3">
      <label className="text-sm text-foreground">種類<select className={control} value={draft.kind} onChange={e => setDraft({ ...draft, kind: e.target.value as LearningPractice["kind"] })}>{Object.entries(PRACTICE_KIND_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
      <label className="text-sm text-foreground">能力<select className={control} value={draft.capability} onChange={e => setDraft({ ...draft, capability: e.target.value as LearningPractice["capability"] })}>{Object.entries(CAPABILITY_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
    </div>
    {draft.variants.map((variant, index) => <fieldset key={variant.id} className="flex flex-col gap-2 rounded-xl border border-border p-3">
      <legend className="px-1 text-sm text-foreground">題目 {index + 1}</legend>
      <label className="text-sm text-foreground">文章／閱讀材料（選填）<textarea className={control} rows={3} maxLength={20000} value={variant.stimulus ?? ""} onChange={e => updateVariant(index, { stimulus: e.target.value || undefined })} /></label>
      <label className="text-sm text-foreground">題目<textarea required className={control} rows={2} maxLength={6000} value={variant.prompt} onChange={e => updateVariant(index, { prompt: e.target.value })} /></label>
      <label className="text-sm text-foreground">正確答案<input required className={control} maxLength={6000} value={variant.answer} onChange={e => updateVariant(index, { answer: e.target.value })} /></label>
      <label className="text-sm text-foreground">其他可接受答案（每行一個）<textarea className={control} rows={2} value={variant.acceptedAnswers.join("\n")} onChange={e => updateVariant(index, { acceptedAnswers: e.target.value.split("\n").filter(v => v.trim()) })} /></label>
      <label className="text-sm text-foreground">答案解釋<textarea required className={control} rows={2} maxLength={6000} value={variant.explanation} onChange={e => updateVariant(index, { explanation: e.target.value })} /></label>
      <label className="text-sm text-foreground">作答提示（選填，使用後不算無提示成功）<input className={control} value={variant.hint ?? ""} onChange={e => updateVariant(index, { hint: e.target.value || undefined })} /></label>
      {draft.variants.length > 1 ? <button type="button" onClick={() => setDraft({ ...draft, variants: draft.variants.filter((_, i) => i !== index) })} className="min-h-11 text-sm text-danger">移除這個題目</button> : null}
    </fieldset>)}
    <button type="button" disabled={draft.variants.length >= 30} onClick={() => setDraft({ ...draft, variants: [...draft.variants, blank()] })} className="min-h-11 rounded-lg border border-border px-3 py-2 text-sm text-foreground">增加不同題目／情境</button>
    <label className="flex min-h-11 items-center gap-2 text-sm text-foreground"><input type="checkbox" checked={draft.learned} onChange={e => setDraft({ ...draft, learned: e.target.checked, enabled: e.target.checked })} />這個內容我已學過，確認加入練習</label>
    {draft.learned ? <label className="flex min-h-11 items-center gap-2 text-sm text-foreground"><input type="checkbox" checked={draft.enabled} onChange={e => setDraft({ ...draft, enabled: e.target.checked })} />啟用排題（取消只暫停，保留進度）</label> : null}
    <p className="text-xs leading-5 text-foreground-muted">尚未學過的內容可以先保存，不會排題。重大題目／答案變更建立新版本並保留原作答。多個題目可確認是否能換情境回想；單一題目不代表會廣泛應用。</p>
    {error ? <p role="alert" className="text-sm text-danger">{error}</p> : null}
    <button type="submit" disabled={saving} className="min-h-12 rounded-xl bg-primary px-4 py-3 font-semibold text-primary-foreground">{saving ? "保存中…" : "保存內容"}</button>
  </form>;
}
