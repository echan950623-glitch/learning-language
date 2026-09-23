"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, type FormEvent } from "react";

import type {
  AbilityKind,
  Exercise,
  LearningItem,
  StudySessionExerciseResult,
  StudySessionPlannedUnit,
} from "@/domain/types";
import type { QueueEntryKind } from "@/domain/queue";
import { buildExerciseForUnit } from "@/domain/exercises";
import { buildQuickQuizUnits } from "@/domain/practice";
import { gradeAttempt, type GradeAttemptResult } from "@/domain/grading";
import { computeUpcomingReviewOverview, summarizeSessionResultsByAbility } from "@/domain/stats";
import { formatDurationMs } from "@/domain/time";
import { getRepository, describePersistenceError } from "@/repository";
import { EmptyState } from "@/components/EmptyState";
import { Badge } from "@/components/Badge";
import { abilityDisplayLabel } from "@/lib/labels";
import { readDailyNewItemCap, readStudyQuestionCount } from "@/lib/studyPreferences";
import { checkAttemptSubmission, initializeStudySession, resolveAttemptResync } from "./sessionInit";

type Phase = "loading" | "empty" | "active" | "summary" | "error";
/** 一題的作答子狀態：answering＝還沒送出；graded＝已自動評分，等待使用者按下一題。 */
type SubPhase = "answering" | "graded";

const KIND_LABEL: Record<QueueEntryKind, string> = {
  review: "複習",
  new: "新內容",
};

const ABILITY_THEME: Record<AbilityKind, { badgeTone: "recall" | "reading"; accentClass: string; buttonClass: string }> = {
  recall: {
    badgeTone: "recall",
    accentClass: "bg-practice-recall",
    buttonClass: "bg-practice-recall text-practice-button-foreground hover:brightness-110",
  },
  reading: {
    badgeTone: "reading",
    accentClass: "bg-practice-reading",
    buttonClass: "bg-practice-reading text-practice-button-foreground hover:brightness-110",
  },
};

function buildHint(expectedAnswer: string): string {
  const chars = Array.from(expectedAnswer);
  if (chars.length <= 1) return expectedAnswer;
  return `${chars[0]}…（共 ${chars.length} 字）`;
}

/** 只給錯誤訊息用的唯讀計數：同語言同時有幾筆進行中的 session。 */
function countInProgress(repository: ReturnType<typeof getRepository>): number {
  try {
    return repository.listStudySessions({ language: "ja", status: "all" }).filter((s) => s.status === "in_progress").length;
  } catch {
    return -1;
  }
}

export default function StudyPage() {
  const router = useRouter();

  const [phase, setPhase] = useState<Phase>("loading");
  const [initError, setInitError] = useState<string | null>(null);
  const [quickQuizError, setQuickQuizError] = useState<string | null>(null);
  const [quickQuizStarting, setQuickQuizStarting] = useState(false);
  const quickQuizStartingRef = useRef(false);

  const [itemsById, setItemsById] = useState<Map<string, LearningItem>>(new Map());
  const [sessionId, setSessionId] = useState("");
  const [plannedUnits, setPlannedUnits] = useState<StudySessionPlannedUnit[]>([]);
  const [exerciseResults, setExerciseResults] = useState<StudySessionExerciseResult[]>([]);
  const [currentIndex, setCurrentIndex] = useState(0);
  const [currentExercise, setCurrentExercise] = useState<Exercise | null>(null);

  const [subPhase, setSubPhase] = useState<SubPhase>("answering");
  const [attemptText, setAttemptText] = useState("");
  const [hintUsed, setHintUsed] = useState(false);
  const [gradedResult, setGradedResult] = useState<GradeAttemptResult | null>(null);
  const [questionShownAt, setQuestionShownAt] = useState(0);
  const [gradeError, setGradeError] = useState<string | null>(null);
  const [gradeRequiresReload, setGradeRequiresReload] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const isSubmittingRef = useRef(false);
  const advancingRef = useRef(false);

  const [correctionError, setCorrectionError] = useState<string | null>(null);
  const [isCorrecting, setIsCorrecting] = useState(false);
  const isCorrectingRef = useRef(false);

  const [abandonConfirming, setAbandonConfirming] = useState(false);
  const [abandonError, setAbandonError] = useState<string | null>(null);

  const [upcomingOverview, setUpcomingOverview] = useState<{ dueWithinOneDay: number; dueWithinWeek: number } | null>(
    null
  );

  // ---- 初始化：優先恢復進行中的 session（R3），沒有才建立新的 ----------------------
  // 決策邏輯抽在 sessionInit.ts（純函式＋可測試），這裡只負責把結果映射成畫面狀態。
  useEffect(() => {
    const repository = getRepository();
    const result = initializeStudySession(repository, new Date(), readStudyQuestionCount(), readDailyNewItemCap());

    if (result.phase === "empty") {
      setPhase("empty");
      return;
    }

    if (result.phase === "error") {
      setInitError(result.message);
      setPhase("error");
      return;
    }

    setItemsById(result.itemsById);
    setSessionId(result.session.id);
    setPlannedUnits(result.session.plannedUnits);
    setExerciseResults(result.session.exerciseResults);
    setCurrentIndex(result.resumeIndex);
    setPhase("active");
  }, []);

  function startQuickQuiz() {
    if (quickQuizStartingRef.current) return;
    quickQuizStartingRef.current = true;
    setQuickQuizStarting(true);
    setQuickQuizError(null);

    try {
      const repository = getRepository();
      const items = repository.listItems({ language: "ja" });
      const units = buildQuickQuizUnits(items, readStudyQuestionCount());
      if (units.length === 0) {
        setQuickQuizError("目前沒有可出題的日文內容，請先新增學習項目。");
        return;
      }

      const session = repository.getOrCreateInProgressSession("ja", units, new Date());
      const nextItemsById = new Map(items.map((item) => [item.id, item]));
      if (session.plannedUnits.slice(session.exerciseResults.length).some((unit) => !nextItemsById.has(unit.learningItemId))) {
        setQuickQuizError("進行中的學習內容已變更，請重新載入後再試。");
        return;
      }

      setItemsById(nextItemsById);
      setSessionId(session.id);
      setPlannedUnits(session.plannedUnits);
      setExerciseResults(session.exerciseResults);
      setCurrentIndex(session.exerciseResults.length);
      setPhase("active");
    } catch (error) {
      setQuickQuizError(describePersistenceError(error));
    } finally {
      quickQuizStartingRef.current = false;
      setQuickQuizStarting(false);
    }
  }

  // ---- 每次換題（含剛進入 active）重新產生題目內容並重設單題狀態 -----------------
  useEffect(() => {
    if (phase !== "active") return;
    const unit = plannedUnits[currentIndex];
    const item = unit ? itemsById.get(unit.learningItemId) : undefined;
    if (!unit || !item) return;

    setCurrentExercise(buildExerciseForUnit(item, unit.ability));
    setSubPhase("answering");
    setAttemptText("");
    setHintUsed(false);
    setGradedResult(null);
    setGradeError(null);
    setGradeRequiresReload(false);
    setCorrectionError(null);
    setQuestionShownAt(Date.now());
    advancingRef.current = false;
  }, [phase, currentIndex, plannedUnits, itemsById]);

  function handleSubmitAnswer(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (isSubmittingRef.current) return; // 防止表單被重複送出
    const trimmed = attemptText.trim();
    if (trimmed.length === 0) return; // 空白不可送出（按鈕本身也會 disabled，這裡是防禦性檢查）

    const unit = plannedUnits[currentIndex];
    const item = unit ? itemsById.get(unit.learningItemId) : undefined;
    if (!unit || !item || !currentExercise) return;

    const graded = gradeAttempt({
      ability: unit.ability,
      rawInput: attemptText,
      expectedAnswer: currentExercise.expectedAnswer,
    });

    isSubmittingRef.current = true;
    setIsSubmitting(true);
    setGradeError(null);

    const responseTimeMs = Math.max(0, Date.now() - questionShownAt);
    const repository = getRepository();

    const latestSession = repository
      .listStudySessions({ language: "ja", status: "all" })
      .find((candidate) => candidate.id === sessionId);
    const check = checkAttemptSubmission({ session: latestSession, currentIndex, learningItemId: item.id, ability: unit.ability });
    if (!check.current) {
      // 守門擋下這次送出是對的（位置已經不一樣了），但不能停在死路——直接把畫面對齊到
      // 這筆 session 現在真正的位置，使用者就地重答即可，不必重新載入、也不會再多開一個
      // session；真的沒辦法接續時才退回重新載入。
      // 失敗原因直接寫進畫面上的訊息：實機一直重現不出來時，這一行就是唯一能指出
      // 「到底是哪一項對不上」的證據，不必另外開診斷面板。
      const why = `［${check.reason}：${check.detail}；in_progress ${countInProgress(repository)} 筆］`;
      const resync = resolveAttemptResync(repository, sessionId, "ja");
      if (resync.kind === "realign") {
        setItemsById(new Map(repository.listItems({ language: "ja" }).map((entry) => [entry.id, entry])));
        setPlannedUnits(resync.session.plannedUnits);
        setExerciseResults(resync.session.exerciseResults);
        setCurrentIndex(resync.index);
        setGradeRequiresReload(false);
        setGradeError(`同步已更新這次學習的進度，已跳到目前這一題，請再作答一次。${why}`);
      } else {
        setGradeRequiresReload(true);
        setGradeError(`同步已更新這次學習的進度。這個舊畫面不會再送出答案，請重新載入最新進度。${why}`);
      }
      isSubmittingRef.current = false;
      setIsSubmitting(false);
      return;
    }

    try {
      const outcome = repository.recordGradedAttempt({
        sessionId,
        learningItemId: item.id,
        ability: unit.ability,
        exerciseId: currentExercise.id,
        exerciseType: currentExercise.exerciseType,
        result: graded.correct ? "correct" : "incorrect",
        usedHint: hintUsed,
        responseTimeMs,
        now: new Date(),
      });

      setExerciseResults(outcome.session.exerciseResults);
      setGradedResult(graded);
      setSubPhase("graded");
    } catch (error) {
      // R4：寫入失敗就停在原題，不推進、不顯示成功；使用者可以直接重按送出重試
      // （同一個 exerciseId 重試是安全的：失敗代表這次評分完全沒有寫入任何東西）。
      setGradeError(`${describePersistenceError(error)}再按一次下面的按鈕重試。`);
    } finally {
      isSubmittingRef.current = false;
      setIsSubmitting(false);
    }
  }

  function handleMarkCorrect() {
    if (isCorrectingRef.current) return;
    if (!currentExercise || !gradedResult || gradedResult.correct) return;

    isCorrectingRef.current = true;
    setIsCorrecting(true);
    setCorrectionError(null);

    const repository = getRepository();
    try {
      const outcome = repository.markAttemptCorrect({ sessionId, exerciseId: currentExercise.id });
      setExerciseResults(outcome.session.exerciseResults);
      setGradedResult((prev) => (prev ? { ...prev, correct: true } : prev));
    } catch (error) {
      setCorrectionError(describePersistenceError(error));
    } finally {
      isCorrectingRef.current = false;
      setIsCorrecting(false);
    }
  }

  function handleNext() {
    if (advancingRef.current) return; // 防止 Enter／點擊重複觸發造成跳題
    advancingRef.current = true;

    if (currentIndex + 1 >= plannedUnits.length) {
      const repository = getRepository();
      const freshSchedules = repository.listScheduleStates({ language: "ja" });
      setUpcomingOverview(computeUpcomingReviewOverview(freshSchedules, "ja", new Date()));
      setPhase("summary");
    } else {
      // 換下一題時以「本機真正存下來的進度」為準，不是畫面上那個可能已經過期的計數器。
      // 背景同步會在作答之間重寫 store 並換掉 repository 實例；沿用舊計數器就會送出到
      // 錯的位置，然後被送出前的核對擋下來。這裡先對齊，讓守門不必當作唯一防線。
      const repository = getRepository();
      const resync = resolveAttemptResync(repository, sessionId, "ja");
      if (resync.kind === "realign") {
        setItemsById(new Map(repository.listItems({ language: "ja" }).map((entry) => [entry.id, entry])));
        setPlannedUnits(resync.session.plannedUnits);
        setExerciseResults(resync.session.exerciseResults);
        setCurrentIndex(resync.index);
      } else {
        setCurrentIndex((i) => i + 1);
      }
    }
  }

  function handleAbandonClick() {
    if (!abandonConfirming) {
      setAbandonConfirming(true);
      return;
    }
    const repository = getRepository();
    try {
      repository.abandonSession(sessionId);
      router.push("/");
    } catch (error) {
      setAbandonError(describePersistenceError(error));
      setAbandonConfirming(false);
    }
  }

  if (phase === "loading") {
    return (
      <main className="mx-auto flex w-[94%] max-w-xl flex-1 flex-col gap-4 py-6" aria-live="polite">
        <div className="h-6 w-32 animate-pulse rounded bg-surface-muted" />
        <div className="h-48 animate-pulse rounded-xl bg-surface-muted" />
      </main>
    );
  }

  if (phase === "error") {
    return (
      <main className="mx-auto flex w-[94%] max-w-xl flex-1 flex-col gap-4 py-6">
        <h1 className="text-xl font-semibold text-foreground">今日學習</h1>
        <div role="alert" className="rounded-xl bg-danger-bg px-4 py-3 text-sm text-danger">
          無法開始今日學習：{initError}
        </div>
        <button
          type="button"
          onClick={() => window.location.reload()}
          className="rounded-xl bg-primary px-4 py-3 text-sm font-semibold text-primary-foreground"
        >
          重試
        </button>
      </main>
    );
  }

  if (phase === "empty") {
    return (
      <main className="mx-auto flex w-[94%] max-w-xl flex-1 flex-col gap-4 py-6">
        <h1 className="text-xl font-semibold text-foreground">今日學習</h1>
        <EmptyState
          title="今天沒有待複習或新內容"
          description="先新增一個日文學習項目，明天或稍後就會出現在這裡。"
          action={
            <Link
              href="/add"
              className="inline-block rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground"
            >
              去新增內容
            </Link>
          }
        />
        <section className="rounded-2xl border border-border bg-surface p-4" aria-labelledby="quick-quiz-title">
          <h2 id="quick-quiz-title" className="text-base font-semibold text-foreground">快速測驗</h2>
          <p className="mt-2 text-sm leading-6 text-foreground-muted">
            從所有已儲存的日文內容隨機出題，不用等到複習日。
          </p>
          <button
            type="button"
            onClick={startQuickQuiz}
            disabled={quickQuizStarting}
            className="mt-4 min-h-12 w-full rounded-xl bg-primary px-4 py-3 text-sm font-semibold text-primary-foreground disabled:cursor-not-allowed disabled:opacity-60"
          >
            {quickQuizStarting ? "正在準備題目…" : "開始快速測驗"}
          </button>
          {quickQuizError ? <p role="alert" className="mt-3 text-sm text-danger">{quickQuizError}</p> : null}
        </section>
      </main>
    );
  }

  if (phase === "summary") {
    const correctCount = exerciseResults.filter((r) => r.result === "correct").length;
    const incorrectCount = exerciseResults.filter((r) => r.result === "incorrect").length;
    const hintCount = exerciseResults.filter((r) => r.usedHint).length;
    const totalMs = exerciseResults.reduce((sum, r) => sum + r.responseTimeMs, 0);
    const newItemCount = new Set(plannedUnits.filter((u) => u.kind === "new").map((u) => u.learningItemId)).size;
    const abilitySummary = summarizeSessionResultsByAbility(exerciseResults);

    const struggledItemIds = new Set(
      exerciseResults.filter((r) => r.result === "incorrect").map((r) => r.learningItemId)
    );
    const struggledItems = Array.from(struggledItemIds)
      .map((id) => itemsById.get(id))
      .filter((item): item is LearningItem => Boolean(item));

    return (
      <main className="mx-auto flex w-[94%] max-w-xl flex-1 flex-col gap-4 py-6">
        <h1 className="text-xl font-semibold text-foreground">今日結算</h1>

        <section className="rounded-2xl border border-border bg-surface p-4">
          <dl className="grid grid-cols-2 gap-3">
            <div>
              <dt className="text-xs text-foreground-muted">完成題數</dt>
              <dd className="text-xl font-semibold tabular-nums">{exerciseResults.length}</dd>
            </div>
            <div>
              <dt className="text-xs text-foreground-muted">花費時間</dt>
              <dd className="text-xl font-semibold">{formatDurationMs(totalMs)}</dd>
            </div>
            <div>
              <dt className="text-xs text-foreground-muted">答對／答錯</dt>
              <dd className="text-xl font-semibold tabular-nums">
                {correctCount} / {incorrectCount}
              </dd>
            </div>
            <div>
              <dt className="text-xs text-foreground-muted">使用提示次數</dt>
              <dd className="text-xl font-semibold tabular-nums">{hintCount}</dd>
            </div>
            <div>
              <dt className="text-xs text-foreground-muted">漢字練習正確率</dt>
              <dd className="text-xl font-semibold tabular-nums">
                {abilitySummary.recall.total > 0
                  ? `${abilitySummary.recall.accuracyPercent}%（${abilitySummary.recall.correct}/${abilitySummary.recall.total}）`
                  : "—"}
              </dd>
            </div>
            <div>
              <dt className="text-xs text-foreground-muted">平假名練習正確率</dt>
              <dd className="text-xl font-semibold tabular-nums">
                {abilitySummary.reading.total > 0
                  ? `${abilitySummary.reading.accuracyPercent}%（${abilitySummary.reading.correct}/${abilitySummary.reading.total}）`
                  : "—"}
              </dd>
            </div>
            <div>
              <dt className="text-xs text-foreground-muted">新增接觸項目</dt>
              <dd className="text-xl font-semibold tabular-nums">{newItemCount}</dd>
            </div>
            <div>
              <dt className="text-xs text-foreground-muted">下次到期（1 天內／7 天內）</dt>
              <dd className="text-xl font-semibold tabular-nums">
                {upcomingOverview ? `${upcomingOverview.dueWithinOneDay} / ${upcomingOverview.dueWithinWeek}` : "—"}
              </dd>
            </div>
          </dl>
        </section>

        <section className="rounded-2xl border border-border bg-surface p-4">
          <h2 className="text-sm font-medium text-foreground-muted">需要加強</h2>
          {struggledItems.length === 0 ? (
            <p className="mt-1 text-sm text-foreground-muted">這次沒有答錯的項目，保持下去。</p>
          ) : (
            <ul className="mt-2 flex flex-col gap-1">
              {struggledItems.map((item) => (
                <li key={item.id} className="text-sm text-foreground">
                  {item.promptZh} → {item.answer}
                </li>
              ))}
            </ul>
          )}
        </section>

        <div className="flex flex-col gap-2">
          <Link
            href="/progress"
            className="rounded-xl bg-primary px-4 py-3 text-center text-sm font-semibold text-primary-foreground"
          >
            查看進度頁
          </Link>
          <Link
            href="/"
            className="rounded-xl border border-border px-4 py-3 text-center text-sm font-medium text-foreground"
          >
            回首頁
          </Link>
        </div>
      </main>
    );
  }

  const unit = plannedUnits[currentIndex];
  const item = unit ? itemsById.get(unit.learningItemId) : undefined;
  const total = plannedUnits.length;

  if (!unit || !item || !currentExercise) {
    return (
      <main className="mx-auto flex w-[94%] max-w-xl flex-1 flex-col gap-4 py-6" aria-live="polite">
        <div className="h-6 w-32 animate-pulse rounded bg-surface-muted" />
        <div className="h-48 animate-pulse rounded-xl bg-surface-muted" />
      </main>
    );
  }

  const kind: QueueEntryKind = unit.kind;
  const ability: AbilityKind = unit.ability;
  const abilityTheme = ABILITY_THEME[ability];
  const isLastQuestion = currentIndex + 1 >= total;

  return (
    <main className="mx-auto flex w-[94%] max-w-xl flex-1 flex-col gap-4 py-6">
      <header>
        <div className="flex items-center justify-between">
          <h1 className="text-xl font-semibold text-foreground">今日學習</h1>
          <span className="text-sm tabular-nums text-foreground-muted">
            {currentIndex + 1} / {total}
          </span>
        </div>
        <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-surface-muted">
          <div
            className="h-full rounded-full bg-primary transition-[width]"
            style={{ width: `${Math.round(((currentIndex + (subPhase === "graded" ? 0.5 : 0)) / total) * 100)}%` }}
          />
        </div>
        <div className="mt-2 flex justify-end">
          {abandonConfirming ? (
            <div className="flex items-center gap-2 text-xs">
              <span className="text-foreground-muted">確定要放棄本次學習？已完成的題目不會被刪除。</span>
              <button type="button" onClick={handleAbandonClick} className="font-medium text-danger">
                確認放棄
              </button>
              <button
                type="button"
                onClick={() => setAbandonConfirming(false)}
                className="font-medium text-foreground-muted"
              >
                取消
              </button>
            </div>
          ) : (
            <button type="button" onClick={handleAbandonClick} className="text-xs text-foreground-muted underline">
              放棄本次學習
            </button>
          )}
        </div>
        {abandonError ? <p className="mt-1 text-xs text-danger">{abandonError}</p> : null}
      </header>

      <section className="relative flex flex-1 flex-col gap-4 overflow-hidden rounded-2xl border border-border bg-surface p-4 pt-5">
        <div aria-hidden="true" className={`absolute inset-x-0 top-0 h-1.5 ${abilityTheme.accentClass}`} />
        <div className="flex items-center gap-2">
          <Badge tone={kind === "review" ? "primary" : "neutral"}>{KIND_LABEL[kind]}</Badge>
          <Badge tone={abilityTheme.badgeTone}>{abilityDisplayLabel(ability, item)}</Badge>
        </div>

        <div>
          <p className="text-sm text-foreground-muted">
            {ability === "reading" ? "這個字的假名讀音是？" : "請回想日文怎麼說："}
          </p>
          <p className="mt-1 text-3xl font-semibold text-foreground">{currentExercise.prompt}</p>
        </div>

        {subPhase === "answering" ? (
          <form
            onSubmit={handleSubmitAnswer}
            className="mt-[clamp(2rem,10dvh,5rem)] flex flex-col gap-3 sm:mt-auto"
          >
            <div className="flex flex-col gap-1">
              <label htmlFor="attempt" className="text-sm font-medium text-foreground">
                你的答案
              </label>
              <input
                key={currentExercise.id}
                id="attempt"
                type="text"
                value={attemptText}
                onChange={(e) => setAttemptText(e.target.value)}
                autoFocus
                autoComplete="off"
                autoCorrect="off"
                autoCapitalize="off"
                spellCheck={false}
                className="scroll-mt-4 rounded-lg border border-border bg-surface px-3 py-3 text-lg text-foreground"
                placeholder="輸入答案，按 Enter 或下方按鈕送出"
              />
            </div>

            {hintUsed ? (
              <p className="rounded-lg bg-surface-muted px-3 py-2 text-sm text-foreground">
                提示：{buildHint(currentExercise.expectedAnswer)}
              </p>
            ) : (
              <button
                type="button"
                onClick={() => setHintUsed(true)}
                className="rounded-xl border border-border px-4 py-2.5 text-sm font-medium text-foreground transition-colors hover:bg-surface-muted"
              >
                顯示提示（限一次）
              </button>
            )}

            {gradeError ? (
              <p role="alert" className="rounded-lg bg-danger-bg px-3 py-2 text-sm text-danger">
                {gradeError}
              </p>
            ) : null}

            {gradeRequiresReload ? (
              <button
                type="button"
                onClick={() => window.location.reload()}
                className="rounded-xl bg-primary px-4 py-3 text-sm font-semibold text-primary-foreground transition-colors hover:opacity-90"
              >
                重新載入最新進度
              </button>
            ) : (
              <button
                type="submit"
                disabled={isSubmitting || attemptText.trim().length === 0}
                className={`rounded-xl px-4 py-3 text-sm font-semibold shadow-sm transition-[filter,transform] active:translate-y-px disabled:cursor-not-allowed disabled:opacity-50 ${abilityTheme.buttonClass}`}
              >
                確認答案
              </button>
            )}
          </form>
        ) : gradedResult ? (
          <div className="mt-auto flex flex-col gap-3">
            <div
              role={gradedResult.correct ? "status" : "alert"}
              className={`rounded-lg px-3 py-3 ${gradedResult.correct ? "bg-success-bg" : "bg-danger-bg"}`}
            >
              <p className={`text-lg font-semibold ${gradedResult.correct ? "text-success" : "text-danger"}`}>
                {gradedResult.correct ? "答對了" : "答錯了"}
              </p>
              {!gradedResult.correct ? (
                <div className="mt-2 flex flex-col gap-0.5 text-sm text-foreground">
                  <p>你的答案：{gradedResult.normalizedInput || "（空白）"}</p>
                  <p>正確答案：{gradedResult.expectedAnswer}</p>
                </div>
              ) : (
                <p className="mt-1 text-sm text-foreground">正確答案：{gradedResult.expectedAnswer}</p>
              )}
              {item.explanation ? <p className="mt-2 text-sm text-foreground-muted">{item.explanation}</p> : null}
            </div>

            {correctionError ? (
              <p role="alert" className="text-xs text-danger">
                {correctionError}
              </p>
            ) : null}

            {!gradedResult.correct ? (
              <button
                type="button"
                onClick={handleMarkCorrect}
                disabled={isCorrecting}
                className="self-start text-xs font-medium text-foreground-muted underline disabled:opacity-50"
              >
                我其實答對了
              </button>
            ) : null}

            <button
              type="button"
              autoFocus
              onClick={handleNext}
              className={`rounded-xl px-4 py-3 text-sm font-semibold shadow-sm transition-[filter,transform] active:translate-y-px ${abilityTheme.buttonClass}`}
            >
              {isLastQuestion ? "查看結果" : "下一題"}
            </button>
          </div>
        ) : null}
      </section>
    </main>
  );
}
