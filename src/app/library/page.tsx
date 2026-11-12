"use client";

import Link from "next/link";
import { useMemo, useState } from "react";

import { usePracticeData } from "@/components/PracticeLauncher";
import { JLPT_LEVELS, JLPT_QUESTION_TYPES, parseJlptConceptKey, type JlptLevel, type JlptQuestionType } from "@/domain/jlptLevels";
import { getJlptPracticeCatalog, libraryEntryInput } from "@/domain/jlptPracticeCatalog";
import type { CatalogEntry } from "@/domain/japanesePracticeCatalog";
import { describePersistenceError, mutateRepository } from "@/repository";

const TYPES = Object.keys(JLPT_QUESTION_TYPES) as JlptQuestionType[];
const conceptId = (practice: { conceptKey: string; capability: string }) => `${practice.conceptKey}:${practice.capability}`;

/** Built-in content by level and exam section. Nothing here is studied until the learner switches it on. */
export default function LibraryPage() {
  const { data, error: loadError } = usePracticeData();
  const [level, setLevel] = useState<JlptLevel>("N5");
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState("");
  const catalog = useMemo(() => getJlptPracticeCatalog(), []);
  const added = useMemo(() => new Set((data?.items ?? []).filter(item => item.practice && !item.archivedAt).map(item => conceptId(item.practice!))), [data]);
  const byLevel = (target: JlptLevel) => catalog.filter(entry => parseJlptConceptKey(entry.practice.conceptKey)?.level === target);
  const entries = byLevel(level);

  async function add(group: CatalogEntry[], key: string) {
    if (pending) return;
    setPending(key);
    setError("");
    try {
      await mutateRepository(repository => {
        const existing = new Set(repository.listItems({ language: "ja" }).filter(item => item.practice && !item.archivedAt).map(item => conceptId(item.practice!)));
        return repository.addItemsIfMissing(group.filter(entry => !existing.has(conceptId(entry.practice))).map(libraryEntryInput));
      });
    } catch (caught) {
      setError(describePersistenceError(caught));
    } finally {
      setPending(null);
    }
  }

  return (
    <main className="mx-auto flex w-[88%] max-w-xl flex-1 flex-col gap-10 pb-10 pt-6">
      <Link href="/review" className="min-h-11 py-2 text-sm text-foreground-muted">‹ 複習</Link>
      <header className="-mt-6">
        <p className="eyebrow">Library</p>
        <h1 className="mt-2 font-display text-4xl font-medium tracking-tight text-foreground">內容庫</h1>
        <p className="mt-3 text-sm leading-6 text-foreground-muted">
          內建的原創練習，依級別與題型整理。開啟後，第一次出題前會先看概念卡，之後照複習時程出現。級別是本 App 的教學安排，不是官方考綱。
        </p>
      </header>

      <div role="group" aria-label="級別" className="flex gap-6 border-b border-border">
        {JLPT_LEVELS.map(option => {
          const total = byLevel(option).length;
          return (
            <button key={option} type="button" aria-pressed={level === option} onClick={() => setLevel(option)}
              className={`-mb-px min-h-12 border-b-2 px-1 text-sm tracking-wide transition-colors ${level === option ? "border-foreground font-semibold text-foreground" : "border-transparent text-foreground-muted hover:text-foreground"}`}>
              {option}<span className="ml-1.5 text-xs font-normal tabular-nums text-foreground-muted">{total}</span>
            </button>
          );
        })}
      </div>

      {loadError || error ? <p role="alert" className="text-sm text-danger">{loadError || error}</p> : null}

      {entries.length === 0 ? (
        <p className="border-y border-border py-10 text-center text-sm text-foreground-muted">{level} 的內容還在準備中。</p>
      ) : TYPES.map(type => {
        const concepts = [...new Set(entries.filter(entry => parseJlptConceptKey(entry.practice.conceptKey)?.type === type).map(entry => entry.practice.conceptKey))]
          .map(conceptKey => entries.filter(entry => entry.practice.conceptKey === conceptKey));
        if (!concepts.length) return null;
        const missingOf = (group: CatalogEntry[]) => group.filter(entry => !added.has(conceptId(entry.practice)));
        const remaining = concepts.filter(group => missingOf(group).length === group.length);
        return (
          <section key={type} aria-labelledby={`library-${type}`}>
            <div className="flex items-end justify-between gap-3">
              <h2 id={`library-${type}`} className="eyebrow">{JLPT_QUESTION_TYPES[type]} · 已開啟 {concepts.filter(group => missingOf(group).length === 0).length} / {concepts.length}</h2>
              {remaining.length > 1 ? (
                <button type="button" disabled={!data || pending !== null} onClick={() => add(remaining.flat(), type)} className="min-h-10 text-xs text-foreground-muted underline underline-offset-4 disabled:opacity-50">
                  {pending === type ? "加入中…" : `全部開啟（${remaining.length}）`}
                </button>
              ) : null}
            </div>
            <ul className="mt-3 border-t border-border">
              {concepts.map(group => {
                const choice = group.find(entry => entry.practice.capability === "recognition") ?? group[0];
                const typed = group.find(entry => entry.practice.capability === "production");
                const missing = missingOf(group);
                const key = choice.practice.conceptKey;
                const typedOnly = missing.length > 0 && missing.length < group.length;
                return (
                  <li key={key} className="flex items-center gap-3 border-b border-border py-3">
                    <div className="min-w-0 flex-1">
                      <h3 lang="ja" className="break-words font-medium text-foreground">{choice.title.replace(/^N\d｜/, "").replace(/^文字語彙：/, "")}</h3>
                      <p className="mt-0.5 text-xs text-foreground-muted">{choice.practice.variants.length} 題選擇{typed ? `＋${typed.practice.variants.length} 題打字` : ""}</p>
                    </div>
                    {missing.length === 0 ? <span className="shrink-0 text-xs text-foreground-muted">已開啟</span> : (
                      <button type="button" disabled={!data || pending !== null} onClick={() => add(missing, key)}
                        className="min-h-11 w-24 shrink-0 rounded-xl border border-foreground px-2 text-xs font-semibold text-foreground disabled:border-border disabled:text-foreground-muted">
                        {pending === key ? "加入中…" : typedOnly ? "補上打字題" : "開啟"}
                      </button>
                    )}
                  </li>
                );
              })}
            </ul>
          </section>
        );
      })}
    </main>
  );
}
