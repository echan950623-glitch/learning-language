"use client";
import Link from "next/link";
import { usePracticeData } from "./PracticeLauncher";
import { createDailyPlan, learningDay } from "@/domain/learningRules";
import { limitVerificationUnits } from "@/domain/automaticVerification";
import { getRepository } from "@/repository";
import { readBusyMode, readDailyNewItemCap, readStudyQuestionCount } from "@/lib/studyPreferences";

export function EnglishHome() {
  const { data, error } = usePracticeData("en");
  const now = new Date();
  const plan = data ? createDailyPlan(data.items, data.schedules, now, readDailyNewItemCap(), readBusyMode(), getRepository().listDailyPlans().find(p => p.language === "en" && p.date === learningDay(now)), undefined, data.attempts, "en") : undefined;
  const remaining = plan?.units.filter(u => !plan.completedUnitKeys.includes(`${u.learningItemId}:${u.ability}`)) ?? [];
  const count = data ? limitVerificationUnits(remaining, data.items, data.schedules, data.attempts, plan?.busy ? Math.min(5, readStudyQuestionCount()) : readStudyQuestionCount()).length : 0;
  return <div className="flex flex-col gap-5">
    <header><h1 className="text-2xl font-semibold text-foreground">英文學習</h1><p className="mt-1 text-sm text-foreground-muted">累積單字與片語，逐步看懂日常、職場與技術英文。</p></header>
    {error ? <p role="alert" className="text-danger">{error}</p> : null}
    <section className="rounded-2xl border border-border bg-surface p-4">
      <h2 className="font-semibold text-foreground">{data?.session ? "上次還沒練完" : "今日學習"}</h2>
      <p className="mt-2 text-sm text-foreground-muted">{!data ? "載入進度…" : data.session ? `已完成 ${data.session.exerciseResults.length} / ${data.session.plannedUnits.length} 題` : count ? `這輪安排 ${count} 題，到期複習優先。` : "目前沒有待安排的題目。"}</p>
      {data && (data.session || count > 0) ? <Link href="/study?language=en" className="mt-3 block min-h-12 rounded-xl bg-primary px-4 py-3 text-center font-semibold text-primary-foreground">{data.session ? "繼續上次學習" : "開始今日學習"}</Link> : data && !data.items.some(i => i.englishPractice) ? <p className="mt-3 text-sm leading-6 text-foreground-muted">還沒有英文練習內容。請在 GPT 準備單字、指定詞義與句子變體，預覽並確認加入後再回來。</p> : null}
      <p className="mt-3 text-xs leading-5 text-foreground-muted">到期時換情境複習；同一輪固定題目。選擇辨義不代表已能拼寫或口說。</p>
    </section>
    <Link href="/progress?language=en" className="min-h-12 rounded-xl border border-border bg-surface px-4 py-3 text-center font-medium text-primary">查看單字與片語</Link>
  </div>;
}
