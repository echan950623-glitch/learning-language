"use client";
import { useState } from "react";
import { usePracticeData } from "./PracticeLauncher";
import { englishEvidence, englishModeVerified, englishStatus } from "@/domain/englishPractice";
import { STATUS_LABELS } from "@/lib/labels";
import { describePersistenceError, mutateRepository } from "@/repository";
import type { LearningItem } from "@/domain/types";
import { ReviewScheduleSummary } from "./ReviewScheduleSummary";

export function EnglishProgress() {
  const { data, error } = usePracticeData("en");
  const [search, setSearch] = useState("");
  const [tag, setTag] = useState("全部");
  const [type, setType] = useState("全部");
  const [status, setStatus] = useState("全部");
  const [limit, setLimit] = useState(20);
  const query = search.trim().toLowerCase();
  const items = (data?.items ?? []).filter(i => !i.coachReport && !i.archivedAt).map(i => ({ ...i, status: englishStatus(i, data!.schedules, data!.attempts) }));
  const filtered = items.filter(i => (!query || `${i.answer} ${i.promptZh}`.toLowerCase().includes(query)) && (tag === "全部" || i.tags.includes(tag)) && (type === "全部" || (type === "單字" ? i.type === "vocabulary" : i.type !== "vocabulary")) && (status === "全部" || i.status === status)).sort((a,b) => b.createdAt.localeCompare(a.createdAt));
  const reset = () => setLimit(20);
  return <main className="mx-auto flex w-[94%] max-w-xl flex-1 flex-col gap-4 py-6">
    <header><h1 className="text-xl font-semibold text-foreground">英文進度</h1><p className="mt-1 text-sm text-foreground-muted">{data ? `${items.length} 個單字與片語 · ${items.filter(i => i.status === "mastered").length} 個穩定理解` : "載入進度…"}</p></header>
    {error ? <p role="alert" className="text-danger">{error}</p> : null}
    <label className="text-sm text-foreground">搜尋單字或詞義<input value={search} onChange={e => {setSearch(e.target.value);reset();}} className="mt-1 min-h-11 w-full rounded-lg border border-border bg-surface px-3 py-2" /></label>
    <div className="grid grid-cols-2 gap-2">
      <label className="text-sm">分類<select aria-label="分類" value={tag} onChange={e => {setTag(e.target.value);reset();}} className="mt-1 min-h-11 w-full rounded-lg border border-border bg-surface p-2">{["全部","日常","多益／職場","技術"].map(t => <option key={t}>{t}</option>)}</select></label>
      <label className="text-sm">類型<select aria-label="類型" value={type} onChange={e => {setType(e.target.value);reset();}} className="mt-1 min-h-11 w-full rounded-lg border border-border bg-surface p-2">{["全部","單字","片語／搭配"].map(t => <option key={t}>{t}</option>)}</select></label>
      <label className="col-span-2 text-sm">學習狀態<select aria-label="學習狀態" value={status} onChange={e => {setStatus(e.target.value);reset();}} className="mt-1 min-h-11 w-full rounded-lg border border-border bg-surface p-2"><option>全部</option>{Object.entries(STATUS_LABELS).map(([v,l]) => <option key={v} value={v}>{l}</option>)}</select></label>
    </div>
    {data && !filtered.length ? <p className="rounded-xl bg-surface p-4 text-sm text-foreground-muted">{items.length ? "沒有符合篩選的內容。" : "還沒有英文單字。請先在 GPT 預覽並確認加入。"}</p> : null}
    {filtered.slice(0,limit).map(item => <details key={item.id} className="rounded-xl border border-border bg-surface p-4">
      <summary className="min-h-11 cursor-pointer text-foreground"><span lang="en" className="font-semibold">{item.answer}</span><span className="ml-2 text-xs text-foreground-muted">{STATUS_LABELS[item.status]}{item.reviewPaused ? " · 已暫停" : ""}</span><p className="mt-1 text-sm">{item.promptZh}</p></summary>
      <p className="mt-2 text-xs text-foreground-muted">{item.partOfSpeech} · {item.tags.join("、")}</p>
      {item.englishPractice ? <>
        <ReviewScheduleSummary item={item} schedules={data!.schedules} attempts={data!.attempts} />
        <p className="mt-3 text-sm text-foreground">直接辨義：{englishEvidence(item,data!.attempts,"direct").length} 個合格學習日{englishModeVerified(item,data!.attempts,"direct") ? " · 已驗證" : ""}</p>
        <p className="text-sm text-foreground">句中辨義：{englishEvidence(item,data!.attempts,"context").length} 個合格學習日{englishModeVerified(item,data!.attempts,"context") ? " · 已驗證" : ""}</p>
        <p className="mt-2 text-xs text-foreground-muted">{item.englishPractice.variants.length} 個題目版本；保留題不在此展開。</p>
        <EnglishPause key={`${item.id}:${item.contentVersion}`} item={item} />
      </> : <p className="mt-3 text-sm text-foreground-muted">待補練習內容；舊作答紀錄保留，不自動變成新的辨義證據。</p>}
    </details>)}
    {filtered.length > limit ? <button className="min-h-11 rounded-lg border border-border p-3" onClick={() => setLimit(n => n+20)}>顯示更多</button> : null}
    <p className="text-xs leading-5 text-foreground-muted">只評估指定詞義的理解；不代表拼字、聽力或口說能力。直接與句中辨義分別達到跨日驗證後，才標示穩定理解。</p>
  </main>;
}
function EnglishPause({ item }: { item: LearningItem }) {
  const [confirming,setConfirming] = useState(false), [busy,setBusy] = useState(false), [error,setError] = useState("");
  return <div className="mt-3 flex flex-wrap gap-2">
    <button type="button" disabled={busy} className="min-h-11 rounded-lg border border-border px-3 py-2 text-sm" onClick={async () => {
      if (!confirming) {setConfirming(true);return;}
      setBusy(true);setError("");
      try { await mutateRepository(r => r.editItem(item.id, item.contentVersion ?? 1, {promptZh:item.promptZh, answer:item.answer, reading:item.reading, explanation:item.explanation, partOfSpeech:item.partOfSpeech, exampleSentence:item.exampleSentence, acceptedAnswers:item.acceptedAnswers, answerFormat:item.answerFormat, englishPractice:item.englishPractice, reviewPaused:!item.reviewPaused, autoVerificationRequestedAt:item.autoVerificationRequestedAt},new Date()));setConfirming(false); }
      catch(e){setError(describePersistenceError(e));} finally {setBusy(false);}
    }}>{confirming ? "確認" : item.reviewPaused ? "恢復出題" : "暫停出題"}</button>
    {confirming ? <><button disabled={busy} className="min-h-11 px-3 text-sm" onClick={() => setConfirming(false)}>取消</button><p className="w-full text-xs text-foreground-muted">保留作答紀錄與排程；暫停不等於答對。</p></> : null}
    {error ? <p role="alert" className="text-danger">{error}</p> : null}
  </div>;
}
