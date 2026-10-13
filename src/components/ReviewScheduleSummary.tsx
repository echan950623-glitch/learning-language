import { requiredAbilities } from "@/domain/abilities";
import { verificationState } from "@/domain/automaticVerification";
import { FIXED_REVIEW_INTERVALS } from "@/domain/fixedReview";
import type { LearningItem, ReviewAttempt, ScheduleState } from "@/domain/types";

export function ReviewScheduleSummary({ item, schedules, attempts }: { item: LearningItem; schedules: ScheduleState[]; attempts: ReviewAttempt[] }) {
  return <div className="mt-3 space-y-1 text-xs leading-6 text-foreground-muted">
    {requiredAbilities({ ...item, reviewPaused: false }).map(ability => {
      const schedule = schedules.find(s => s.learningItemId === item.id && s.ability === ability);
      const state = verificationState(item, ability, schedules, attempts);
      const label = ability === "reading" ? "讀音" : ability === "meaning" ? "英文辨義" : "詞義";
      const complete = schedule?.reviewPolicy === 1 && state.stage === "verified";
      const stage = schedule?.reviewPolicy === 1 ? schedule.reviewStage ?? 0 : undefined;
      const phase = stage === undefined ? schedule ? "原定複習" : "尚未開始" : stage === 0 ? "隔天確認" : stage >= 5 ? "等待直接與句中驗證" : `${FIXED_REVIEW_INTERVALS[stage]} 天複習${schedule?.intervalDays === 1 ? "（隔天再確認）" : ""}`;
      return <p key={ability}>{label}：{complete ? "已熟練，退出日常複習" : item.reviewPaused ? "已暫停" : phase}
        {!complete && !item.reviewPaused ? <><br />下次複習：{state.dueAt ? new Date(state.dueAt).toLocaleString("zh-TW", { timeZone: "Asia/Taipei", month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false }) : "學習後安排"}</> : null}
      </p>;
    })}
  </div>;
}
