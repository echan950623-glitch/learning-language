"use client";

import Link from "next/link";
import { ConfirmVocabularyVerification } from "@/components/VocabularyPauseControl";
import { requestVocabularyVerification } from "@/repository/vocabularyPause";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useRef, useState, type FormEvent } from "react";

import type {
  Language,
  AbilityKind,
  Exercise,
  LearningItem,
  StudySessionExerciseResult,
  StudySessionPlannedUnit,
  StudySession,
} from "@/domain/types";
import type { QueueEntryKind } from "@/domain/queue";
import { buildExerciseForUnit } from "@/domain/exercises";
import { buildQuickQuizUnits } from "@/domain/practice";
import { gradeAttempt, type GradeAttemptResult } from "@/domain/grading";
import {
  computeUpcomingReviewOverview,
  summarizeSessionResultsByAbility,
} from "@/domain/stats";
import { formatDurationMs } from "@/domain/time";
import {
  getRepository,
  describePersistenceError,
  mutateRepository,
  waitForRepositoryInitialization,
} from "@/repository";
import { EmptyState } from "@/components/EmptyState";
import { Badge } from "@/components/Badge";
import { abilityDisplayLabel, STUDY_MODE_LABELS } from "@/lib/labels";
import {
  readDailyNewItemCap,
  readStudyQuestionCount,
} from "@/lib/studyPreferences";
import {
  checkAttemptSubmission,
  initializeStudySession,
  resolveAttemptResync,
} from "./sessionInit";
import { prepareDailyPlan } from "./dailyPlan";
import { ActiveStudyClock } from "@/domain/activeStudyClock";
import {
  activePracticeVariant,
  practiceError,
  recentlyExposed,
} from "@/domain/learningPractice";
import {
  learnerText,
  practiceChoices,
  choiceIsAssisted,
} from "@/domain/practicePresentation";

import { activeEnglishVariant } from "@/domain/englishPractice";

type Phase = "loading" | "empty" | "active" | "summary" | "error";
/** 一題的作答子狀態：answering＝還沒送出；graded＝已自動評分，等待使用者按下一題。 */
type SubPhase = "answering" | "graded";

const KIND_LABEL: Record<QueueEntryKind, string> = {
  review: "複習",
  new: "新內容",
};

const ABILITY_THEME: Record<
  AbilityKind,
  { badgeTone: "recall" | "reading"; accentClass: string; buttonClass: string }
> = {
  meaning: { badgeTone: "recall", accentClass: "bg-practice-recall", buttonClass: "bg-practice-recall text-practice-button-foreground hover:brightness-110" },
  recall: {
    badgeTone: "recall",
    accentClass: "bg-practice-recall",
    buttonClass:
      "bg-practice-recall text-practice-button-foreground hover:brightness-110",
  },
  reading: {
    badgeTone: "reading",
    accentClass: "bg-practice-reading",
    buttonClass:
      "bg-practice-reading text-practice-button-foreground hover:brightness-110",
  },
};

/** 只給錯誤訊息用的唯讀計數：同語言同時有幾筆進行中的 session。 */
function countInProgress(repository: ReturnType<typeof getRepository>, language: Language): number {
  try {
    return repository
      .listStudySessions({ language, status: "all" })
      .filter((s) => s.status === "in_progress").length;
  } catch {
    return -1;
  }
}

export default function StudyPage() {
  return <Suspense fallback={<p className="p-6">載入學習…</p>}><StudyLanguage /></Suspense>;
}
function StudyLanguage() {
  const params = useSearchParams();
  const language = params.get("language") === "en" ? "en" : "ja";
  return <StudyScreen key={language} language={language} />;
}
function StudyScreen({ language }: { language: Language }) {
  const router = useRouter();

  const [phase, setPhase] = useState<Phase>("loading");
  const [initError, setInitError] = useState<string | null>(null);
  const [quickQuizError, setQuickQuizError] = useState<string | null>(null);
  const [quickQuizStarting, setQuickQuizStarting] = useState(false);
  const quickQuizStartingRef = useRef(false);

  const [itemsById, setItemsById] = useState<Map<string, LearningItem>>(
    new Map(),
  );
  const [sessionId, setSessionId] = useState("");
  const [sessionSnapshot, setSessionSnapshot] = useState<StudySession | null>(
    null,
  );
  const [introductionSaving, setIntroductionSaving] = useState(false);
  const [clockNow, setClockNow] = useState(() => Date.now());
  const [plannedUnits, setPlannedUnits] = useState<StudySessionPlannedUnit[]>(
    [],
  );
  const [exerciseResults, setExerciseResults] = useState<
    StudySessionExerciseResult[]
  >([]);
  const [currentIndex, setCurrentIndex] = useState(0);
  const [currentExercise, setCurrentExercise] = useState<Exercise | null>(null);

  const [subPhase, setSubPhase] = useState<SubPhase>("answering");
  const [attemptText, setAttemptText] = useState("");
  const [hintUsed, setHintUsed] = useState(false);
  const [gradedResult, setGradedResult] = useState<GradeAttemptResult | null>(
    null,
  );
  const activeClock = useRef(new ActiveStudyClock());
  const [gradeError, setGradeError] = useState<string | null>(null);
  const [gradeRequiresReload, setGradeRequiresReload] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const isSubmittingRef = useRef(false);
  const advancingRef = useRef(false);
  const lastVocabularySkipAt = useRef(-Infinity);

  const [correctionError, setCorrectionError] = useState<string | null>(null);
  const [isCorrecting, setIsCorrecting] = useState(false);
  const isCorrectingRef = useRef(false);

  const [abandonConfirming, setAbandonConfirming] = useState(false);
  const [abandonError, setAbandonError] = useState<string | null>(null);

  const [upcomingOverview, setUpcomingOverview] = useState<{
    dueWithinOneDay: number;
    dueWithinWeek: number;
  } | null>(null);

  // ---- 初始化：優先恢復進行中的 session（R3），沒有才建立新的 ----------------------
  useEffect(() => {
    const update = () =>
      activeClock.current.setVisible(Date.now(), !document.hidden);
    document.addEventListener("visibilitychange", update);
    return () => document.removeEventListener("visibilitychange", update);
  }, []);

  useEffect(() => {
    const availableAt = Date.parse(
      plannedUnits[currentIndex]?.recallNotBefore ?? "",
    );
    const remaining = availableAt - Date.now();
    if (!(remaining > 0)) return;
    const timer = setTimeout(() => {
      setClockNow(Date.now());
      activeClock.current.reset(Date.now(), !document.hidden);
    }, remaining);
    return () => clearTimeout(timer);
  }, [plannedUnits, currentIndex]);
  // 決策邏輯抽在 sessionInit.ts（純函式＋可測試），這裡只負責把結果映射成畫面狀態。
  useEffect(() => {
    let cancelled = false;
    const initialize = async () => {
      await waitForRepositoryInitialization();
      if (cancelled) return;
      const plan = getRepository().getInProgressSession(language)
        ? undefined
        : await prepareDailyPlan(new Date(), language);
      return mutateRepository((repository) =>
        initializeStudySession(
          repository,
          new Date(),
          readStudyQuestionCount(),
          readDailyNewItemCap(),
          plan,
          language,
        ),
      );
    };
    void initialize()
      .then((result) => {
        if (cancelled || !result) return;

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
        setSessionSnapshot(result.session);
        setPlannedUnits(result.session.plannedUnits);
        setExerciseResults(result.session.exerciseResults);
        setCurrentIndex(result.resumeIndex);
        setPhase("active");
      })
      .catch((error) => {
        if (!cancelled) {
          setInitError(describePersistenceError(error));
          setPhase("error");
        }
      });
    return () => {
      cancelled = true;
    };
  }, [language]);

  async function startQuickQuiz() {
    if (quickQuizStartingRef.current) return;
    quickQuizStartingRef.current = true;
    setQuickQuizStarting(true);
    setQuickQuizError(null);

    try {
      const repository = getRepository();
      const items = repository.listItems({ language });
      const units = buildQuickQuizUnits(items, readStudyQuestionCount());
      if (units.length === 0) {
        setQuickQuizError("目前沒有可出題的日文內容，請先新增學習項目。");
        return;
      }

      const session = await mutateRepository((repository) =>
        repository.getOrCreateInProgressSession(language, units, new Date(), {
          mode: "random",
        }),
      );
      const nextItemsById = new Map(items.map((item) => [item.id, item]));
      if (
        session.plannedUnits
          .slice(session.exerciseResults.length)
          .some((unit) => !nextItemsById.has(unit.learningItemId))
      ) {
        setQuickQuizError("進行中的學習內容已變更，請重新載入後再試。");
        return;
      }

      setItemsById(nextItemsById);
      setSessionId(session.id);
      setSessionSnapshot(session);
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
    const item = unit
      ? (unit.itemSnapshot ?? itemsById.get(unit.learningItemId))
      : undefined;
    if (!unit || !item) return;

    setCurrentExercise(buildExerciseForUnit(item, unit.ability));
    setSubPhase("answering");
    setAttemptText("");
    const savedSession = getRepository()
      .listStudySessions({ status: "all" })
      .find((session) => session.id === sessionId);
    setHintUsed(!!savedSession?.hintedIndices?.includes(currentIndex));
    setGradedResult(null);
    setGradeError(null);
    setGradeRequiresReload(false);
    setCorrectionError(null);
    activeClock.current.reset(Date.now(), !document.hidden);
    advancingRef.current = false;
  }, [phase, currentIndex, plannedUnits, itemsById, sessionId]);

  async function handleSubmitAnswer(
    event?: FormEvent<HTMLFormElement>,
    forgotten = false,
  ) {
    event?.preventDefault();
    if (isSubmittingRef.current) return; // 防止表單被重複送出
    const trimmed = attemptText.trim();
    if (trimmed.length === 0 && !forgotten) return;

    const unit = plannedUnits[currentIndex];
    const item = unit
      ? (unit.itemSnapshot ?? itemsById.get(unit.learningItemId))
      : undefined;
    if (!unit || !item || !currentExercise) return;

    const graded = gradeAttempt({
      ability: unit.ability,
      rawInput: forgotten ? "" : attemptText,
      expectedAnswer: currentExercise.expectedAnswer,
      acceptedAnswers:
        unit.ability === "recall"
          ? [
              ...(item.acceptedAnswers ?? []),
              ...(item.reading && item.answerFormat !== "kanji"
                ? [item.reading]
                : []),
            ]
          : undefined,
    });

    isSubmittingRef.current = true;
    setIsSubmitting(true);
    setGradeError(null);

    const responseTimeMs = activeClock.current.elapsed(Date.now());
    const repository = getRepository();

    const latestSession = repository
      .listStudySessions({ language, status: "all" })
      .find((candidate) => candidate.id === sessionId);
    const check = checkAttemptSubmission({
      session: latestSession,
      currentIndex,
      learningItemId: item.id,
      ability: unit.ability,
    });
    if (!check.current) {
      // 守門擋下這次送出是對的（位置已經不一樣了），但不能停在死路——直接把畫面對齊到
      // 這筆 session 現在真正的位置，使用者就地重答即可，不必重新載入、也不會再多開一個
      // session；真的沒辦法接續時才退回重新載入。
      // 失敗原因直接寫進畫面上的訊息：實機一直重現不出來時，這一行就是唯一能指出
      // 「到底是哪一項對不上」的證據，不必另外開診斷面板。
      const why = `［${check.reason}：${check.detail}；in_progress ${countInProgress(repository, language)} 筆］`;
      const resync = resolveAttemptResync(repository, sessionId, language);
      if (resync.kind === "realign") {
        setItemsById(
          new Map(
            repository
              .listItems({ language, includeArchived: true })
              .map((entry) => [entry.id, entry]),
          ),
        );
        setPlannedUnits(resync.session.plannedUnits);
        setExerciseResults(resync.session.exerciseResults);
        setCurrentIndex(resync.index);
        setGradeRequiresReload(false);
        setGradeError(
          `同步已更新這次學習的進度，已跳到目前這一題，請再作答一次。${why}`,
        );
      } else {
        setGradeRequiresReload(true);
        setGradeError(
          `同步已更新這次學習的進度。這個舊畫面不會再送出答案，請重新載入最新進度。${why}`,
        );
      }
      isSubmittingRef.current = false;
      setIsSubmitting(false);
      return;
    }

    try {
      const outcome = await mutateRepository((repository) => {
        const fresh = repository
          .listStudySessions({ language, status: "all" })
          .find((s) => s.id === sessionId);
        if (
          !checkAttemptSubmission({
            session: fresh,
            currentIndex,
            learningItemId: item.id,
            ability: unit.ability,
          }).current
        )
          throw new Error("同步或另一個分頁已更新進度，請重新載入後再作答。");
        return repository.recordGradedAttempt({
          sessionId,
          learningItemId: item.id,
          ability: unit.ability,
          exerciseId: currentExercise.id,
          exerciseType: currentExercise.exerciseType,
          result: graded.correct ? "correct" : "incorrect",
          usedHint: hintUsed || choiceIsAssisted(item),
          responseTimeMs,
          now: new Date(),
          rawAnswer: forgotten ? "" : attemptText,
          normalizedAnswer: graded.normalizedInput,
        });
      });

      setExerciseResults(outcome.session.exerciseResults);
      setSessionSnapshot(outcome.session);
      setGradedResult(graded);
      setSubPhase("graded");
    } catch (error) {
      // R4：寫入失敗就停在原題，不推進、不顯示成功；使用者可以直接重按送出重試
      // （同一個 exerciseId 重試是安全的：失敗代表這次評分完全沒有寫入任何東西）。
      setGradeError(
        `${describePersistenceError(error)}再按一次下面的按鈕重試。`,
      );
    } finally {
      isSubmittingRef.current = false;
      setIsSubmitting(false);
    }
  }

  async function handleMarkCorrect() {
    if (isCorrectingRef.current) return;
    if (!currentExercise || !gradedResult || gradedResult.correct) return;

    isCorrectingRef.current = true;
    setIsCorrecting(true);
    setCorrectionError(null);

    try {
      const outcome = await mutateRepository((repository) =>
        repository.markAttemptCorrect({
          sessionId,
          exerciseId: currentExercise.id,
        }),
      );
      setExerciseResults(outcome.session.exerciseResults);
      setSessionSnapshot(outcome.session);
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

    const freshSession = getRepository()
      .listStudySessions({ status: "all" })
      .find((session) => session.id === sessionId);
    if (freshSession?.status === "completed") {
      setPlannedUnits(freshSession.plannedUnits);
      const repository = getRepository();
      const freshSchedules = repository.listScheduleStates({ language });
      setUpcomingOverview(
        computeUpcomingReviewOverview(freshSchedules, language, new Date()),
      );
      setPhase("summary");
    } else {
      // 換下一題時以「本機真正存下來的進度」為準，不是畫面上那個可能已經過期的計數器。
      // 背景同步會在作答之間重寫 store 並換掉 repository 實例；沿用舊計數器就會送出到
      // 錯的位置，然後被送出前的核對擋下來。這裡先對齊，讓守門不必當作唯一防線。
      const repository = getRepository();
      const resync = resolveAttemptResync(repository, sessionId, language);
      if (resync.kind === "realign") {
        setItemsById(
          new Map(
            repository
              .listItems({ language, includeArchived: true })
              .map((entry) => [entry.id, entry]),
          ),
        );
        setPlannedUnits(resync.session.plannedUnits);
        setSessionSnapshot(resync.session);
        setExerciseResults(resync.session.exerciseResults);
        setCurrentIndex(resync.index);
      } else {
        setCurrentIndex((i) => i + 1);
      }
    }
  }

  async function skipKnownVocabulary() {
    const clickedAt = performance.now();
    if (isSubmittingRef.current || clickedAt - lastVocabularySkipAt.current < 500) return;
    const unit = plannedUnits[currentIndex];
    if (!unit) return;
    lastVocabularySkipAt.current = clickedAt;
    isSubmittingRef.current = true;
    setIsSubmitting(true);
    try {
      const session = await mutateRepository((repository) =>
        requestVocabularyVerification(repository, sessionId, currentIndex, unit.learningItemId, new Date()),
      );
      setSessionSnapshot(session);
      setPlannedUnits(session.plannedUnits);
      setExerciseResults(session.exerciseResults);
      setCurrentIndex(session.exerciseResults.length);
      if (session.status === "completed") setPhase("summary");
    } catch (error) {
      setGradeError(describePersistenceError(error));
    } finally {
      isSubmittingRef.current = false;
      setIsSubmitting(false);
    }
  }

  async function understandItem(itemId: string, alreadyKnown = false) {
    if (isSubmittingRef.current) return;
    isSubmittingRef.current = true;
    setIntroductionSaving(true);
    try {
      const session = await mutateRepository((repository) =>
        repository.acknowledgeIntroduction(
          sessionId,
          itemId,
          new Date(),
          alreadyKnown,
        ),
      );
      setSessionSnapshot(session);
      setPlannedUnits(session.plannedUnits);
      setClockNow(Date.now());
      activeClock.current.reset(Date.now(), !document.hidden);
    } catch (error) {
      setGradeError(describePersistenceError(error));
    } finally {
      isSubmittingRef.current = false;
      setIntroductionSaving(false);
    }
  }

  async function handleAbandonClick() {
    if (!abandonConfirming) {
      setAbandonConfirming(true);
      return;
    }
    try {
      await mutateRepository((repository) =>
        repository.abandonSession(sessionId),
      );
      router.push("/");
    } catch (error) {
      setAbandonError(describePersistenceError(error));
      setAbandonConfirming(false);
    }
  }

  if (phase === "loading") {
    return (
      <main
        className="mx-auto flex w-[94%] max-w-xl flex-1 flex-col gap-4 py-6"
        aria-live="polite"
      >
        <div className="h-6 w-32 animate-pulse rounded bg-surface-muted" />
        <div className="h-48 animate-pulse rounded-xl bg-surface-muted" />
      </main>
    );
  }

  if (phase === "error") {
    return (
      <main className="mx-auto flex w-[94%] max-w-xl flex-1 flex-col gap-4 py-6">
        <h1 className="text-xl font-semibold text-foreground">今日學習</h1>
        <div
          role="alert"
          className="rounded-xl bg-danger-bg px-4 py-3 text-sm text-danger"
        >
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
    const hasSavedItems =
      getRepository().listItems({ language }).length > 0;
    return (
      <main className="mx-auto flex w-[94%] max-w-xl flex-1 flex-col gap-4 py-6">
        <h1 className="text-xl font-semibold text-foreground">今日學習</h1>
        <EmptyState
          title={
            hasSavedItems
              ? "目前的今日計畫已完成，或沒有需要安排的題目"
              : language === "en" ? "收件匣還沒有英文練習內容" : "收件匣還沒有日文內容"
          }
          description={
            hasSavedItems
              ? "新字額度與到期日仍會保留。可回首頁選擇想練的內容。"
              : language === "en" ? "請先在 GPT 預覽並確認加入英文單字與題目變體。" : "請先在 GPT 對話中預覽並確認加入日文內容，再開始今日複習。"
          }
          action={
            <Link
              href="/"
              className="inline-block rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground"
            >
              回首頁選練習
            </Link>
          }
        />
        <section
          className="rounded-2xl border border-border bg-surface p-4"
          aria-labelledby="quick-quiz-title"
          hidden={language === "en"}
        >
          <h2
            id="quick-quiz-title"
            className="text-base font-semibold text-foreground"
          >
            快速測驗
          </h2>
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
          {quickQuizError ? (
            <p role="alert" className="mt-3 text-sm text-danger">
              {quickQuizError}
            </p>
          ) : null}
        </section>
      </main>
    );
  }

  if (phase === "summary") {
    const firstResults = exerciseResults.filter(
      (result) => !result.attemptNumber,
    );
    const correctCount = firstResults.filter(
      (r) => r.result === "correct",
    ).length;
    const incorrectCount = firstResults.filter(
      (r) => r.result === "incorrect",
    ).length;
    const hintCount = exerciseResults.filter((r) => r.usedHint).length;
    const totalMs = exerciseResults.reduce(
      (sum, r) => sum + r.responseTimeMs,
      0,
    );
    const newItemCount = new Set(
      plannedUnits.filter((u) => u.kind === "new").map((u) => u.learningItemId),
    ).size;
    const abilitySummary = summarizeSessionResultsByAbility(firstResults);

    const struggledItemIds = new Set(
      exerciseResults
        .filter((r) => r.result === "incorrect")
        .map((r) => r.learningItemId),
    );
    const struggledItems = Array.from(struggledItemIds)
      .map(
        (id) =>
          plannedUnits.find((unit) => unit.learningItemId === id)
            ?.itemSnapshot ?? itemsById.get(id),
      )
      .filter((item): item is LearningItem => Boolean(item));

    return (
      <main className="mx-auto flex w-[94%] max-w-xl flex-1 flex-col gap-4 py-6">
        <h1 className="text-xl font-semibold text-foreground">
          {sessionSnapshot?.mode && sessionSnapshot.mode !== "today"
            ? `${STUDY_MODE_LABELS[sessionSnapshot.mode]}結算`
            : "今日結算"}
        </h1>

        <section className="rounded-2xl border border-border bg-surface p-4">
          <dl className="grid grid-cols-2 gap-3">
            <div>
              <dt className="text-xs text-foreground-muted">完成題數</dt>
              <dd className="text-xl font-semibold tabular-nums">
                {exerciseResults.length}
              </dd>
            </div>
            <div>
              <dt className="text-xs text-foreground-muted">花費時間</dt>
              <dd className="text-xl font-semibold">
                {formatDurationMs(totalMs)}
              </dd>
            </div>
            <div>
              <dt className="text-xs text-foreground-muted">首答／補考題數</dt>
              <dd className="text-xl font-semibold tabular-nums">
                {firstResults.length} /{" "}
                {exerciseResults.length - firstResults.length}
              </dd>
            </div>
            <div>
              <dt className="text-xs text-foreground-muted">首答答對／答錯</dt>
              <dd className="text-xl font-semibold tabular-nums">
                {correctCount} / {incorrectCount}
              </dd>
            </div>
            <div>
              <dt className="text-xs text-foreground-muted">
                提示／近期曝光協助
              </dt>
              <dd className="text-xl font-semibold tabular-nums">
                {hintCount}
              </dd>
            </div>
            <div>
              <dt className="text-xs text-foreground-muted">
                {plannedUnits.some((unit) => unit.itemSnapshot?.practice)
                  ? "回想／文字練習首答正確率"
                  : "詞彙首答正確率"}
              </dt>
              <dd className="text-xl font-semibold tabular-nums">
                {abilitySummary[language === "en" ? "meaning" : "recall"].total > 0
                  ? `${abilitySummary[language === "en" ? "meaning" : "recall"].accuracyPercent}%（${abilitySummary[language === "en" ? "meaning" : "recall"].correct}/${abilitySummary[language === "en" ? "meaning" : "recall"].total}）`
                  : "—"}
              </dd>
            </div>
            <div>
              <dt className="text-xs text-foreground-muted">{language === "en" ? "本輪題型" : "讀音首答正確率"}</dt>
              <dd className="text-xl font-semibold tabular-nums">
                {language === "en" ? "四選一辨義" : abilitySummary.reading.total > 0
                  ? `${abilitySummary.reading.accuracyPercent}%（${abilitySummary.reading.correct}/${abilitySummary.reading.total}）`
                  : "—"}
              </dd>
            </div>
            <div>
              <dt className="text-xs text-foreground-muted">新增接觸項目</dt>
              <dd className="text-xl font-semibold tabular-nums">
                {newItemCount}
              </dd>
            </div>
            <div>
              <dt className="text-xs text-foreground-muted">
                下次到期（1 天內／7 天內）
              </dt>
              <dd className="text-xl font-semibold tabular-nums">
                {upcomingOverview
                  ? `${upcomingOverview.dueWithinOneDay} / ${upcomingOverview.dueWithinWeek}`
                  : "—"}
              </dd>
            </div>
          </dl>
        </section>

        <section className="rounded-2xl border border-border bg-surface p-4">
          <h2 className="text-sm font-medium text-foreground-muted">
            需要加強
          </h2>
          {struggledItems.length === 0 ? (
            <p className="mt-1 text-sm text-foreground-muted">
              這次沒有答錯的項目，保持下去。
            </p>
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
            href={language === "en" ? "/progress?language=en" : "/progress"}
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
  const item = unit
    ? (unit.itemSnapshot ?? itemsById.get(unit.learningItemId))
    : undefined;
  const total = plannedUnits.length;

  if (!unit || !item || !currentExercise) {
    return (
      <main
        className="mx-auto flex w-[94%] max-w-xl flex-1 flex-col gap-4 py-6"
        aria-live="polite"
      >
        <div className="h-6 w-32 animate-pulse rounded bg-surface-muted" />
        <div className="h-48 animate-pulse rounded-xl bg-surface-muted" />
      </main>
    );
  }

  const kind: QueueEntryKind = unit.kind;
  const ability: AbilityKind = unit.ability;
  const abilityTheme = ABILITY_THEME[ability];
  const choices = practiceChoices(item);
  const englishVariant = activeEnglishVariant(item);
  const isLastQuestion = currentIndex + 1 >= total;

  const introductionUnit = unit.requiresIntroduction
    ? plannedUnits
        .slice(currentIndex)
        .find(
          (candidate) =>
            candidate.requiresIntroduction &&
            !sessionSnapshot?.understoodItemIds?.includes(
              candidate.learningItemId,
            ),
        )
    : undefined;
  const introductionItem =
    introductionUnit?.itemSnapshot ??
    (introductionUnit
      ? itemsById.get(introductionUnit.learningItemId)
      : undefined);
  if (introductionItem)
    return (
      <main className="mx-auto flex w-[94%] max-w-xl flex-1 flex-col gap-4 py-6">
        <h1 className="text-xl font-semibold text-foreground">
          先理解{introductionItem.practice ? "練習內容" : "新字"}
        </h1>
        <p className="text-sm text-foreground-muted">
          {language === "en" ? "先看指定詞義與例句，再練習辨義。理解卡不計入答對率。" : "先看詞義、讀音和例句，接著做無提示回想。理解卡不計入答對率。"}
        </p>
        <section className="flex flex-col gap-4 rounded-2xl border border-border bg-surface p-5">
          <Badge tone="neutral">理解卡</Badge>
          <p className="text-3xl font-semibold text-foreground">
            {introductionItem.answer}
          </p>
          <p className="text-lg text-foreground">{introductionItem.reading}</p>
          <p className="text-foreground">
            {introductionItem.promptZh}
            {introductionItem.partOfSpeech
              ? `（${introductionItem.partOfSpeech}）`
              : ""}
          </p>
          {introductionItem.englishPractice ? (
            <p lang="en" className="rounded-lg bg-surface-muted p-3 text-foreground">{introductionItem.englishPractice.variants.find(v => v.mode === "context" && v.role === "practice")?.sentence}</p>
          ) : introductionItem.exampleSentence ? (
            <p className="rounded-lg bg-surface-muted p-3 text-foreground">
              {introductionItem.exampleSentence}
            </p>
          ) : !introductionItem.practice ? (
            <p className="text-sm text-foreground-muted">
              尚無短例句，可在單字管理中補上。
            </p>
          ) : null}
          {introductionItem.explanation ? (
            <p className="text-sm text-foreground-muted">
              {introductionItem.explanation}
            </p>
          ) : null}
          <button
            type="button"
            disabled={introductionSaving}
            onClick={() => understandItem(introductionItem.id)}
            className="min-h-12 rounded-xl bg-primary px-4 py-3 font-semibold text-primary-foreground"
          >
            已理解，繼續
          </button>
          <button
            type="button"
            disabled={introductionSaving}
            onClick={() => understandItem(introductionItem.id, true)}
            className="min-h-12 rounded-xl border border-border px-4 py-3 text-foreground"
          >
            這個已經會了（接著驗證回想）
          </button>
          {gradeError ? (
            <p role="alert" className="text-sm text-danger">
              {gradeError}
            </p>
          ) : null}
        </section>
      </main>
    );

  if (unit.recallNotBefore && Date.parse(unit.recallNotBefore) > clockNow)
    return (
      <main className="mx-auto flex w-[94%] max-w-xl flex-1 flex-col gap-4 py-6">
        <h1 className="text-xl font-semibold text-foreground">
          理解已保存，稍後再回想
        </h1>
        <p className="text-sm leading-6 text-foreground-muted">
          這輪其他題目不足，先保留三分鐘間隔，避免看完答案立刻抄寫。你可以先離開，重新開啟會接續這一題。
        </p>
        <p className="text-sm text-foreground">
          可回想時間：
          {new Date(unit.recallNotBefore).toLocaleTimeString("zh-TW", {
            timeZone: "Asia/Taipei",
            hour: "2-digit",
            minute: "2-digit",
          })}
          （台北）
        </p>
        <Link
          href="/"
          className="min-h-12 rounded-xl bg-primary px-4 py-3 text-center text-primary-foreground"
        >
          返回今日計畫
        </Link>
      </main>
    );

  return (
    <main className="mx-auto flex w-[94%] max-w-xl flex-1 flex-col gap-4 py-6">
      <header>
        <div className="flex items-center justify-between">
          <h1 className="text-xl font-semibold text-foreground">
            {language === "en" ? "英文 · " : ""}{STUDY_MODE_LABELS[sessionSnapshot?.mode ?? "today"]}
          </h1>
          <span className="text-sm tabular-nums text-foreground-muted">
            {currentIndex + 1} / {total}
          </span>
        </div>
        <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-surface-muted">
          <div
            className="h-full rounded-full bg-primary transition-[width]"
            style={{
              width: `${Math.round(((currentIndex + (subPhase === "graded" ? 0.5 : 0)) / total) * 100)}%`,
            }}
          />
        </div>
        <div className="mt-2 flex justify-end">
          {abandonConfirming ? (
            <div className="flex items-center gap-2 text-xs">
              <span className="text-foreground-muted">
                確定要放棄本次學習？已完成的題目不會被刪除。
              </span>
              <button
                type="button"
                onClick={handleAbandonClick}
                className="font-medium text-danger"
              >
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
            <button
              type="button"
              onClick={handleAbandonClick}
              className="text-xs text-foreground-muted underline"
            >
              放棄本次學習
            </button>
          )}
        </div>
        {abandonError ? (
          <p className="mt-1 text-xs text-danger">{abandonError}</p>
        ) : null}
      </header>

      <section className="relative flex flex-1 flex-col gap-4 overflow-hidden rounded-2xl border border-border bg-surface p-4 pt-5">
        <div
          aria-hidden="true"
          className={`absolute inset-x-0 top-0 h-1.5 ${abilityTheme.accentClass}`}
        />
        <div className="flex items-center gap-2">
          <Badge tone={kind === "review" ? "primary" : "neutral"}>
            {KIND_LABEL[kind]}
          </Badge>
          <Badge tone={abilityTheme.badgeTone}>
            {abilityDisplayLabel(ability, item)}
          </Badge>
        </div>

        <div>
          {item.verificationQuestion ? <p className="mb-2 text-xs font-medium text-primary">{(unit.attemptNumber ?? 0) > 0 ? "補強" : "自動驗證"} · {item.verificationQuestion.novel ? "不同題目" : "間隔後確認記憶"}</p> : null}
          <p className="text-sm text-foreground-muted">
            {item.englishPractice ? "請選擇這個英文表達的意思。" : item.practice
              ? "依題目要求回答；讀音與詞義用來排除生字干擾。"
              : item.verificationQuestion
                ? "依下面的句子回答："
                : ability === "reading"
                ? "這個字的假名讀音是？"
                : "請回想日文怎麼說："}
          </p>
          {activePracticeVariant(item)?.stimulus ? (
            <p
              lang={language}
              className="mt-3 whitespace-pre-wrap rounded-lg bg-surface-muted p-3 text-base leading-8 text-foreground"
            >
              {activePracticeVariant(item)!.stimulus}
            </p>
          ) : null}
          <p
            className={`mt-3 whitespace-pre-wrap font-semibold text-foreground ${item.practice || item.englishPractice || item.verificationQuestion ? "text-lg leading-8" : "text-3xl"}`}
          >
            {learnerText(currentExercise.prompt)
              .replace(/ている・/g, "現在進行／狀態（ている）・")
              .replace(
                choices.length ? /請用中文回答|請輸入|只輸入|只填/g : /$^/g,
                "請選擇",
              )}
          </p>
          {recentlyExposed(
            item,
            getRepository().listReviewAttempts({ language }),
            new Date(),
          ) && subPhase === "answering" ? (
            <p className="mt-2 text-xs text-foreground-muted">
              近期看過同內容，這題會記為有曝光的補強，不算獨立回想成功。
            </p>
          ) : null}
        </div>

        {subPhase === "answering" ? (
          <form
            onSubmit={handleSubmitAnswer}
            className={language === "en" ? "mt-2 flex flex-col gap-3 sm:mt-auto" : "mt-[clamp(2rem,10dvh,5rem)] flex flex-col gap-3 sm:mt-auto"}
          >
            {choices.length ? (
              <fieldset className="flex flex-col gap-2">
                <legend className="mb-2 text-sm font-medium text-foreground">
                  選擇答案
                </legend>
                {choices.map((choice) => (
                  <label
                    key={choice}
                    className={`flex min-h-12 cursor-pointer items-center gap-3 rounded-xl border p-3 text-foreground ${attemptText === choice ? "border-primary bg-surface-muted" : "border-border bg-surface"}`}
                  >
                    <input
                      type="radio"
                      name="answer-choice"
                      value={choice}
                      checked={attemptText === choice}
                      disabled={isSubmitting}
                      onChange={() => setAttemptText(choice)}
                      className="h-4 w-4 shrink-0 accent-primary"
                    />
                    <span className="whitespace-pre-wrap text-base">
                      {choice}
                    </span>
                  </label>
                ))}
                {choiceIsAssisted(item) ? (
                  <p className="text-xs text-foreground-muted">
                    這題練習選擇辨認，不算自行回想成功。
                  </p>
                ) : null}
              </fieldset>
            ) : (
              <div className="flex flex-col gap-1">
                <label
                  htmlFor="attempt"
                  className="text-sm font-medium text-foreground"
                >
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
                  onKeyDown={(event) => {
                    if (event.key === "Enter" && event.nativeEvent.isComposing)
                      event.preventDefault();
                  }}
                  className="scroll-mt-4 rounded-lg border border-border bg-surface px-3 py-3 text-lg text-foreground"
                  placeholder="輸入答案，按 Enter 或下方按鈕送出"
                />
              </div>
            )}

            {englishVariant?.hint ? <button type="button" disabled={isSubmitting || hintUsed} onClick={async () => { try { await mutateRepository(r => r.recordHint(sessionId, currentIndex)); setHintUsed(true); } catch(e) { setGradeError(describePersistenceError(e)); } }} className="min-h-11 rounded-xl border border-border px-4 py-2 text-foreground">{hintUsed ? englishVariant.hint : "看提示"}</button> : null}
            {(item.type === "vocabulary" || item.englishPractice) && !item.practice && !item.verificationQuestion ? (
              <ConfirmVocabularyVerification
                key={`${sessionId}:${currentIndex}:${item.id}`}
                onConfirm={skipKnownVocabulary}
                disabled={isSubmitting || gradeRequiresReload}
              />
            ) : null}

            <button
              type="button"
              disabled={isSubmitting}
              onClick={() => handleSubmitAnswer(undefined, true)}
              className="min-h-12 rounded-xl border border-border px-4 py-3 text-sm font-medium text-foreground"
            >
              想不起來
            </button>

            {gradeError ? (
              <p
                role="alert"
                className="rounded-lg bg-danger-bg px-3 py-2 text-sm text-danger"
              >
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
              <p
                className={`text-lg font-semibold ${gradedResult.correct ? "text-success" : "text-danger"}`}
              >
                {gradedResult.correct ? "答對了" : "答錯了"}
              </p>
              {!gradedResult.correct ? (
                <div className="mt-2 flex flex-col gap-0.5 text-sm text-foreground">
                  <p>你的答案：{gradedResult.normalizedInput || "（空白）"}</p>
                  <p>正確答案：{gradedResult.expectedAnswer}</p>
                </div>
              ) : (
                <p className="mt-1 text-sm text-foreground">
                  正確答案：{gradedResult.expectedAnswer}
                </p>
              )}
              <p className="mt-2 text-sm text-foreground-muted">
                {learnerText(
                  item.explanation ||
                    `${item.answer}${item.reading ? `（${item.reading}）` : ""}：${item.promptZh}`,
                )}
              </p>
              {englishVariant ? <div className="rounded-lg bg-surface-muted p-3 text-sm leading-6 text-foreground"><p>{englishVariant.translationZh}</p><p>{englishVariant.explanationZh}</p></div> : null}
            {!gradedResult.correct && item.practice ? (
                <p className="mt-2 text-sm text-foreground-muted">
                  {practiceError(item, attemptText)?.category}：
                  {practiceError(item, attemptText)?.explanation}
                </p>
              ) : null}
              {item.exampleSentence ? (
                <p className="mt-2 text-sm text-foreground-muted">
                  例句：{item.exampleSentence}
                </p>
              ) : null}
              {!gradedResult.correct ? (
                <p className="mt-2 text-sm text-foreground-muted">
                  有足夠間隔時會安排補考，每個能力最多兩次；重答仍錯也可以完成本輪。
                </p>
              ) : null}
              {!gradedResult.correct && language !== "en" &&
              (getRepository().getScheduleState(
                unit.learningItemId,
                unit.ability,
              )?.recentFailures ?? 0) >= 3 ? (
                <p className="mt-2 text-sm text-foreground-muted">
                  這個能力最近反覆失敗。先回單字管理重新理解詞義與例句、檢查可接受答案；也可以先休息，稍後再做，不需要一直加題。
                </p>
              ) : null}
            </div>

            {correctionError ? (
              <p role="alert" className="text-xs text-danger">
                {correctionError}
              </p>
            ) : null}

            {!gradedResult.correct && language !== "en" ? (
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
