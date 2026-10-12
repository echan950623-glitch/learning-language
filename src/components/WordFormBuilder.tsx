"use client";
import { useState, useRef } from "react";
import type { LearningItem } from "@/domain/types";
import { conjugationCatalog } from "@/domain/japanesePracticeCatalog";
import type { JapaneseWordClass } from "@/domain/japaneseConjugation";
import { practiceInput } from "@/domain/learningPractice";
import { mutateRepository, describePersistenceError } from "@/repository";
const classes: Record<JapaneseWordClass, string> = { godan: "五段／第一類動詞", ichidan: "一段／第二類動詞", suru: "する／第三類", kuru: "来る／第三類", i_adjective: "い形容詞", na_adjective: "な形容詞", noun: "名詞" };
export function WordFormBuilder({ items }: { items: LearningItem[] }) {
  const words = items.filter(item => item.type === "vocabulary" && item.reading && !item.archivedAt);
  const [itemId, setItemId] = useState(""); const [wordClass, setWordClass] = useState<JapaneseWordClass>("godan"); const [formId, setFormId] = useState("te");
  const [confirmed, setConfirmed] = useState(false); const [error, setError] = useState(""); const [message, setMessage] = useState(""); const [saving, setSaving] = useState(false);
  const busy = useRef(false);
  const word = words.find(item => item.id === itemId);
  const entries = word ? conjugationCatalog([{ dictionary: word.answer, reading: word.reading!, wordClass, meaning: word.promptZh }]) : [];
  const entry = entries.find(entry => entry.practice.formId === formId);
  async function save() {
    if (!entry || !word || !confirmed || busy.current) return;
    busy.current = true;
    setSaving(true); setError(""); setMessage("");
    try {
      const practice = { ...entry.practice, title: `${word.answer}・${entry.title}`, conceptKey: `word-form:${word.answer}:${formId}`, learned: true, enabled: true };
      const added = await mutateRepository(repository => {
        if (repository.listItems({ language: "ja", includeArchived: true }).some(item => item.practice?.conceptKey === practice.conceptKey && item.practice.capability === practice.capability)) throw new Error("這個能力已有紀錄，請使用上方內容管理，避免建立重複項目。");
        return repository.addItemsIfMissing([practiceInput(practice)]);
      });
      setMessage(added.length ? "已加入這個詞的變化練習。原單字進度保留；此練習不代表其他動詞也會。" : "這個練習已存在。");
    } catch (error) { setError(describePersistenceError(error)); } finally { busy.current = false; setSaving(false); }
  }
  const control = "mt-1 min-h-11 w-full rounded-lg border border-border bg-surface px-3 py-2 text-foreground";
  return <details className="rounded-2xl border border-border bg-surface p-4"><summary className="min-h-11 cursor-pointer text-sm font-semibold text-foreground">用我的單字練變化</summary>
    <p className="text-xs leading-6 text-foreground-muted">辭書形單字需有讀音。明確確認詞類，不能只看る結尾猜第一／第二類。內建混合練習與單詞練習分開，單詞成功不代表整條規則熟練。</p>
    <label className="mt-3 block text-sm text-foreground">已保存的單字<select className={control} value={itemId} onChange={e => { setItemId(e.target.value); setConfirmed(false); }}><option value="">請選擇</option>{words.map(word => <option key={word.id} value={word.id}>{word.answer}（{word.reading}）：{word.promptZh}</option>)}</select></label>
    <label className="mt-3 block text-sm text-foreground">詞類<select className={control} value={wordClass} onChange={e => { setWordClass(e.target.value as JapaneseWordClass); setConfirmed(false); }}>{Object.entries(classes).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
    <label className="mt-3 block text-sm text-foreground">已學形式<select className={control} value={formId} onChange={e => { setFormId(e.target.value); setConfirmed(false); }}><option value="">請選擇</option>{entries.map(entry => <option key={entry.id} value={entry.practice.formId}>{entry.title}</option>)}</select></label>
    {entry ? <p className="mt-3 rounded-lg bg-surface-muted p-3 text-sm leading-6 text-foreground">樣題：{entry.practice.variants[0].prompt}<br />答案：{entry.practice.variants[0].answer}</p> : word ? <p className="mt-2 text-xs text-foreground-muted">目前形式不適用此詞類，請選可用形式。特殊敬語只提供已核對的動詞。</p> : null}
    <label className="mt-2 flex min-h-11 items-center gap-2 text-sm text-foreground"><input type="checkbox" checked={confirmed} onChange={e => setConfirmed(e.target.checked)} />我確認詞類、樣題答案及這個形式已學過</label>
    <button type="button" disabled={!entry || !confirmed || saving} onClick={save} className="min-h-11 rounded-xl bg-primary px-4 py-2 text-sm text-primary-foreground disabled:opacity-50">加入這個詞的變化練習</button>
    {error ? <p role="alert" className="mt-2 text-sm text-danger">{error}</p> : null}{message ? <p role="status" className="mt-2 text-sm text-success">{message}</p> : null}
  </details>;
}
