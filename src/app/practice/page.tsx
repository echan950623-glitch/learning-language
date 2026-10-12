"use client";
import Link from "next/link";
import { useEffect, useState } from "react";
import {
  PracticeStartButton,
  usePracticeData,
} from "@/components/PracticeLauncher";
import {
  PRACTICE_CATEGORIES,
  learnedPracticeItems,
  selectPracticeUnits,
  type PracticeCategory,
  type PracticeSource,
  type PracticeSkill,
} from "@/domain/practiceSelection";
import { CAPABILITY_LABELS, practiceEvidence } from "@/domain/learningPractice";
import {
  practiceTitle,
  temporalPracticeConcepts,
} from "@/domain/practicePresentation";
import { STATUS_LABELS } from "@/lib/labels";
import {
  readStudyQuestionCount,
  STUDY_QUESTION_COUNT_OPTIONS,
} from "@/lib/studyPreferences";
const selectedClass = "border-primary bg-primary text-primary-foreground",
  normalClass = "border-border bg-surface text-foreground";
export default function PracticePage() {
  const { data, error } = usePracticeData();
  const [category, setCategory] = useState<PracticeCategory>("conjugation");
  const [concepts, setConcepts] = useState<string[]>([]);
  const [skill, setSkill] = useState<PracticeSkill>("mixed");
  const [source, setSource] = useState<PracticeSource>("recommended");
  const [count, setCount] = useState(10);
  useEffect(() => {
    const requested = new URLSearchParams(window.location.search).get(
      "category",
    );
    if (PRACTICE_CATEGORIES.some((c) => c.id === requested))
      setCategory(requested as PracticeCategory);
    setCount(readStudyQuestionCount());
  }, []);
  const items = data
    ? learnedPracticeItems(data.items, data.attempts, data.schedules, category)
    : [];
  const topics = [
    ...new Map(
      items
        .filter((i) => i.practice)
        .map((i) => [
          i.practice!.conceptKey,
          {
            id: i.practice!.conceptKey,
            title: practiceTitle(
              items.find(
                (candidate) =>
                  candidate.practice?.conceptKey === i.practice!.conceptKey &&
                  candidate.practice.capability === "production",
              ) ?? i,
            ),
          },
        ]),
    ).values(),
  ];
  const skills =
    category === "vocabulary"
      ? [
          ...new Set(
            items.flatMap((i) =>
              i.reading && i.reading !== i.answer
                ? ["recall", "reading"]
                : ["recall"],
            ),
          ),
        ]
      : [...new Set(items.map((i) => i.practice!.capability))];
  const skillLabel = (v: string) =>
    v === "recall"
      ? "意思回想"
      : v === "reading"
        ? "讀音回想"
        : v === "production" && category === "conjugation"
          ? "自己變出來"
          : v === "usage"
            ? "放進句子"
            : (CAPABILITY_LABELS[v as keyof typeof CAPABILITY_LABELS] ?? v);
  const selection = { category, concepts, skill, source, questionCount: count };
  const total = data
    ? selectPracticeUnits(
        data.items,
        data.attempts,
        data.schedules,
        selection,
        new Date(),
        () => 0.5,
      ).total
    : 0;
  return (
    <main className="mx-auto flex w-[94%] max-w-xl flex-1 flex-col gap-4 py-6">
      <Link href="/" className="min-h-11 py-2 text-sm text-primary">
        ‹ 首頁
      </Link>
      <h1 className="text-2xl font-semibold text-foreground">
        {PRACTICE_CATEGORIES.find((c) => c.id === category)?.label}
      </h1>
      <label className="text-sm text-foreground">
        練習種類
        <select
          value={category}
          onChange={(e) => {
            setCategory(e.target.value as PracticeCategory);
            setConcepts([]);
            setSkill("mixed");
          }}
          className="mt-2 min-h-11 w-full rounded-xl border border-border bg-surface px-3 text-foreground"
        >
          {PRACTICE_CATEGORIES.map((c) => (
            <option key={c.id} value={c.id}>
              {c.label}
            </option>
          ))}
        </select>
      </label>
      {error ? (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      ) : null}
      {!data ? (
        <p className="text-sm text-foreground-muted">載入進度…</p>
      ) : (
        <>
          {topics.length ? (
            <section className="rounded-2xl border border-border bg-surface p-4">
              <h2 className="font-semibold text-foreground">
                {category === "conjugation" ? "練哪些形式？" : "練哪些內容？"}
              </h2>
              {category === "conjugation" ? (
                <div
                  className="mt-3 flex flex-wrap gap-2"
                  aria-label="依時態選範圍"
                >
                  {(
                    [
                      ["progressive", "現在進行"],
                      ["present", "非過去"],
                      ["past", "過去"],
                    ] as const
                  ).map(([tense, label]) => {
                    const ids = temporalPracticeConcepts(items, tense);
                    return (
                      <button
                        key={tense}
                        type="button"
                        disabled={!ids.length}
                        onClick={() => {
                          setConcepts(ids);
                          setSkill("production");
                        }}
                        className="min-h-11 rounded-xl border border-border px-3 text-sm text-foreground disabled:opacity-50"
                      >
                        {label}
                      </button>
                    );
                  })}
                </div>
              ) : null}
              <label className="mt-2 flex min-h-11 items-center gap-2 text-sm text-foreground">
                <input
                  type="checkbox"
                  checked={!concepts.length}
                  onChange={() => setConcepts([])}
                />
                全部已學內容
              </label>
              <div className="grid grid-cols-2 gap-2">
                {topics.map((t) => (
                  <label
                    key={t.id}
                    className="flex min-h-11 items-center gap-2 text-sm text-foreground"
                  >
                    <input
                      type="checkbox"
                      checked={concepts.includes(t.id)}
                      onChange={(e) =>
                        setConcepts(
                          e.target.checked
                            ? [...concepts, t.id]
                            : concepts.filter((id) => id !== t.id),
                        )
                      }
                    />
                    <span className="min-w-0 break-words">{t.title}</span>
                  </label>
                ))}
              </div>
              <p className="mt-2 text-xs text-foreground-muted">
                只顯示已確認學過、已啟用的內容。
              </p>
            </section>
          ) : (
            <p className="text-sm text-foreground-muted">
              {items.length
                ? "從已學單字中出題。"
                : "尚無可練內容。請告訴 GPT 你學過什麼，預覽確認後加入。"}
            </p>
          )}
          {skills.length > 0 ? (
            <fieldset>
              <legend className="mb-2 text-sm font-semibold text-foreground">
                練習方式
              </legend>
              <div className="flex flex-wrap gap-2">
                {[...skills, ...(skills.length > 1 ? ["mixed"] : [])].map(
                  (v) => (
                    <button
                      key={v}
                      type="button"
                      aria-pressed={
                        skill === v ||
                        (skills.length === 1 && skill === "mixed")
                      }
                      onClick={() => setSkill(v as PracticeSkill)}
                      className={`min-h-11 rounded-xl border px-3 text-sm ${skill === v || (skills.length === 1 && skill === "mixed") ? selectedClass : normalClass}`}
                    >
                      {v === "mixed" ? "混合" : skillLabel(v)}
                    </button>
                  ),
                )}
              </div>
            </fieldset>
          ) : null}
          <fieldset>
            <legend className="mb-2 text-sm font-semibold text-foreground">
              題目來源
            </legend>
            <div className="flex flex-wrap gap-2">
              {(
                [
                  ["recommended", "優先複習"],
                  ["due", "只做到期"],
                  ["wrong", "錯題"],
                  ["all", "全部已學"],
                ] as const
              ).map(([v, label]) => (
                <button
                  key={v}
                  type="button"
                  aria-pressed={source === v}
                  onClick={() => setSource(v)}
                  className={`min-h-11 rounded-xl border px-3 text-sm ${source === v ? selectedClass : normalClass}`}
                >
                  {label}
                </button>
              ))}
            </div>
          </fieldset>
          <fieldset>
            <legend className="mb-2 text-sm font-semibold text-foreground">
              每輪題數
            </legend>
            <div className="flex gap-2">
              {STUDY_QUESTION_COUNT_OPTIONS.map((v) => (
                <button
                  key={v}
                  type="button"
                  aria-pressed={count === v}
                  onClick={() => setCount(v)}
                  className={`min-h-11 min-w-11 rounded-xl border px-3 text-sm ${count === v ? selectedClass : normalClass}`}
                >
                  {v}
                </button>
              ))}
            </div>
          </fieldset>
          <p className="text-xs text-foreground-muted">
            範圍內 {total} 題；本輪安排 {Math.min(total, count)}{" "}
            題。優先複習先排到期與錯題，再補其他已學內容。
          </p>
          <PracticeStartButton
            category={category}
            selection={selection}
            label={`開始練習・${Math.min(total, count)} 題`}
          />
          <details className="rounded-2xl border border-border bg-surface p-4">
            <summary className="min-h-11 cursor-pointer text-sm font-semibold text-foreground">
              查看內容與進度
            </summary>
            {data.items
              .filter(
                (i) =>
                  i.practice &&
                  ((category === "sentence" &&
                    (i.practice.kind === "particle" ||
                      i.practice.kind === "structure")) ||
                    i.practice.kind === category),
              )
              .map((i) => {
                const e = practiceEvidence(i, data.schedules, data.attempts);
                return (
                  <div
                    key={i.id}
                    className="border-t border-border py-3 text-sm text-foreground"
                  >
                    <p>
                      {practiceTitle(i)}・
                      {CAPABILITY_LABELS[i.practice!.capability]}
                    </p>
                    <p className="mt-1 text-xs text-foreground-muted">
                      {!i.practice!.learned
                        ? "未學過"
                        : !i.practice!.enabled
                          ? "已暫停"
                          : STATUS_LABELS[e.status]}
                      ・跨日成功 {e.independentDays} 天・不同題目成功{" "}
                      {e.successfulVariants}/{e.requiredVariants}
                    </p>
                  </div>
                );
              })}
            <p className="mt-2 text-xs text-foreground-muted">
              新增、啟用或暫停練習，請在 GPT 對話中提出。
            </p>
          </details>
        </>
      )}
    </main>
  );
}
