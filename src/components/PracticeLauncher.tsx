"use client";
import { matchesLevels } from "@/domain/jlptLevels";
import { readLevelFilter } from "@/lib/levelFilter";
import { useLevelFilter } from "./LevelFilter";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import {
  learnedPracticeItems,
  selectPracticeUnits,
  type PracticeCategory,
  type PracticeSelection,
} from "@/domain/practiceSelection";
import type {
  Language,
  LearningItem,
  ReviewAttempt,
  ScheduleState,
  StudySession,
} from "@/domain/types";
import {
  describePersistenceError,
  getRepository,
  mutateRepository,
  subscribeDataChanged,
  waitForRepositoryInitialization,
} from "@/repository";
import { readStudyQuestionCount } from "@/lib/studyPreferences";
export function usePracticeData(language: Language = "ja") {
  const [data, setData] = useState<{
    items: LearningItem[];
    attempts: ReviewAttempt[];
    schedules: ScheduleState[];
    session?: StudySession;
  } | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    let active = true,
      ready = false;
    const refresh = () => {
      if (!active || !ready) return;
      const r = getRepository();
      setData({
        items: r.listItems({ language, includeReports: true }),
        attempts: r.listReviewAttempts({ language }),
        schedules: r.listScheduleStates({ language }),
        session: r.getInProgressSession(language),
      });
    };
    const unsub = subscribeDataChanged(refresh);
    void waitForRepositoryInitialization()
      .then(() => {
        ready = true;
        refresh();
      })
      .catch((e) => {
        if (active) setError(describePersistenceError(e));
      });
    return () => {
      active = false;
      unsub();
    };
  }, [language]);
  return { data, error };
}
export function PracticeStartButton({
  category,
  selection,
  label = "開始練習",
  compact = false,
}: {
  category: PracticeCategory;
  selection?: PracticeSelection;
  label?: string;
  compact?: boolean;
}) {
  const { data: allData, error: loadError } = usePracticeData();
  const levels = useLevelFilter();
  // Self-directed practice honours the chosen review levels; scheduled study elsewhere does not.
  const data = allData ? { ...allData, items: allData.items.filter(item => matchesLevels(item, levels)) } : allData;
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);
  const busy = useRef(false);
  const router = useRouter();
  const count = data
    ? learnedPracticeItems(data.items, data.attempts, data.schedules, category)
        .length
    : 0;
  const selected =
    selection && data
      ? selectPracticeUnits(
          data.items,
          data.attempts,
          data.schedules,
          selection,
          new Date(),
          () => 0.5,
        )
      : undefined;
  async function start() {
    if (busy.current) return;
    busy.current = true;
    setPending(true);
    setError("");
    try {
      await waitForRepositoryInitialization();
      await mutateRepository((r) => {
        if (r.getInProgressSession("ja")) return;
        const result = selectPracticeUnits(
          r.listItems({ language: "ja" }).filter(item => matchesLevels(item, readLevelFilter())),
          r.listReviewAttempts({ language: "ja" }),
          r.listScheduleStates({ language: "ja" }),
          selection ?? {
            category,
            source: "recommended",
            skill: "mixed",
            concepts: [],
            questionCount: readStudyQuestionCount(),
          },
          new Date(),
        );
        if (!result.units.length)
          throw new Error(
            "這個範圍目前沒有可練的題目。請調整範圍，或請 GPT 加入已學內容。",
          );
        return r.getOrCreateInProgressSession("ja", result.units, new Date(), {
          mode: result.mode,
        });
      });
      router.push("/study");
    } catch (e) {
      setError(describePersistenceError(e));
    } finally {
      busy.current = false;
      setPending(false);
    }
  }
  return (
    <div>
      {data?.session && !compact ? (
        <Link
          href="/study"
          className="flex min-h-12 items-center justify-center rounded-xl border border-foreground px-4 text-sm font-semibold text-foreground"
        >
          繼續上次練習
        </Link>
      ) : (
        <button
          type="button"
          onClick={start}
          disabled={
            !data ||
            pending ||
            !!data.session ||
            count === 0 ||
            selected?.total === 0
          }
          className={compact
            ? "min-h-11 w-full rounded-xl border border-foreground px-2 text-xs font-semibold text-foreground disabled:border-border disabled:text-foreground-muted"
            : "min-h-12 w-full rounded-xl bg-primary px-4 text-sm font-semibold text-primary-foreground disabled:opacity-40"}
        >
          {pending
            ? compact ? "準備中…" : "準備題目…"
            : data?.session
              ? compact ? "進行中" : "練習進行中"
              : compact && data && count === 0
                ? "尚無內容"
                : label}
        </button>
      )}
      {!compact && data && count === 0 ? (
        <p className="mt-2 text-xs leading-5 text-foreground-muted">
          {category === "vocabulary"
            ? "新單字先從今日複習開始；也可以請 GPT 加入內容。"
            : "請告訴 GPT 你想練什麼，確認加入後就能開始。"}
        </p>
      ) : null}
      {loadError || error ? (
        <p role="alert" className="mt-2 text-xs text-danger">
          {loadError || error}
        </p>
      ) : null}
    </div>
  );
}
