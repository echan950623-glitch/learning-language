import { expect, it } from "vitest";
import { MemoryLearningRepository } from "./memoryRepository";
import { createDailyPlan } from "../domain/learningRules";
import { createEmptyStore, sanitizeStore } from "./schema";
import { computeLearningEvidenceStats } from "../domain/stats";
const NOW = new Date("2026-10-03T06:00:00.000Z");

function setup() {
  const repository = new MemoryLearningRepository();
  for (let index=0;index<8;index++) repository.addItem({ language:"ja",type:"vocabulary",promptZh:`意思 ${index}`,answer:`語${index}`,reading:`ご${index}`,source:"manual",tags:[] });
  const plan=repository.saveDailyPlan(createDailyPlan(repository.listItems(),[],NOW,5));
  const session=repository.getOrCreateInProgressSession("ja",plan.units,NOW,{mode:"today",dailyPlanId:plan.id});
  for (const id of plan.newItemIds) repository.acknowledgeIntroduction(session.id,id,NOW);
  return {repository,plan,session};
}
it("shares distinct-word quota across sessions and restores all question/evidence snapshots",()=>{
  const {repository,plan,session}=setup();
  expect(plan.newItemIds).toHaveLength(5);
  repository.abandonSession(session.id);
  const again=createDailyPlan(repository.listItems(),repository.listScheduleStates(),NOW,5,false,repository.listDailyPlans()[0]);
  expect(again.newItemIds).toEqual(plan.newItemIds);
  const store={...createEmptyStore(),items:repository.listItems(),scheduleStates:repository.listScheduleStates(),reviewAttempts:repository.listReviewAttempts(),studySessions:repository.listStudySessions({status:"all"}),dailyPlans:repository.listDailyPlans()};
  expect(sanitizeStore(JSON.parse(JSON.stringify(store))).usedFallback).toBe(false);
});
it("bounds retries, persists their positions, and never repeats long-term penalties",()=>{
  const {repository,session}=setup();
  let active=repository.getInProgressSession("ja")!;
  let serial=0;
  while(active.status==="in_progress") {
    const unit=active.plannedUnits[active.exerciseResults.length];
    const outcome=repository.recordGradedAttempt({sessionId:session.id,learningItemId:unit.learningItemId,ability:unit.ability,exerciseId:`ex${serial++}`,exerciseType:unit.ability,result:"incorrect",usedHint:false,responseTimeMs:100,now:NOW,rawAnswer:"不知道",normalizedAnswer:"不知道"});
    active=outcome.session;
    expect(active.plannedUnits.length).toBeLessThanOrEqual(session.plannedUnits.length*3);
  }
  expect(active.status).toBe("completed");
  for(const schedule of repository.listScheduleStates()) expect(schedule.lapseCount).toBe(1);
  expect(repository.listReviewAttempts().some(attempt=>(attempt.abilityEvidence?.attemptNumber??0)>0)).toBe(true);
  const stats=computeLearningEvidenceStats(repository.listReviewAttempts(),"ja",NOW);
  expect(stats.firstAttempts).toBe(session.plannedUnits.length);
  expect(stats.retries).toBeGreaterThan(0);
  expect(stats.dueFirstAccuracy.sampleSize).toBe(0);
});
it("persists hint use and retains original grading through an idempotent correction",()=>{
  const {repository,session}=setup();
  repository.recordHint(session.id,0);
  const unit=session.plannedUnits[0];
  const wrong=repository.recordGradedAttempt({sessionId:session.id,learningItemId:unit.learningItemId,ability:unit.ability,exerciseId:"correct-me",exerciseType:unit.ability,result:"incorrect",usedHint:false,responseTimeMs:100,now:NOW,rawAnswer:"原答案",normalizedAnswer:"原答案"});
  expect(wrong.attempt.usedHint).toBe(true);
  const corrected=repository.markAttemptCorrect({sessionId:session.id,exerciseId:"correct-me"});
  expect(corrected.attempt.abilityEvidence).toMatchObject({originalResult:"incorrect",rawAnswer:"原答案"});
  expect(corrected.attempt.abilityEvidence?.corrections).toHaveLength(1);
  expect(repository.markAttemptCorrect({sessionId:session.id,exerciseId:"correct-me"}).attempt.abilityEvidence?.corrections).toHaveLength(1);
  expect(corrected.schedule.evidenceStreak).toBe(0);
  expect(corrected.schedule.lapseCount).toBe(0);
});
it("records an inbox quiz without enrolling it or producing a schedule",()=>{
  const repository=new MemoryLearningRepository();
  const item=repository.addItem({language:"ja",type:"vocabulary",promptZh:"狗",answer:"犬",source:"manual",tags:[]});
  const session=repository.getOrCreateInProgressSession("ja",[{learningItemId:item.id,ability:"recall",kind:"new"}],NOW,{mode:"random"});
  repository.recordGradedAttempt({sessionId:session.id,learningItemId:item.id,ability:"recall",exerciseId:"quiz",exerciseType:"recall",result:"correct",usedHint:false,responseTimeMs:100,now:NOW});
  expect(repository.getItem(item.id)?.status).toBe("new");
  expect(repository.listScheduleStates()).toEqual([]);
});
it("uses a persisted gap for a small introduction batch, with explicit known-word verification",()=>{
  const repository=new MemoryLearningRepository();
  const item=repository.addItem({language:"ja",type:"vocabulary",promptZh:"狗",answer:"犬",source:"manual",tags:[]});
  const plan=repository.saveDailyPlan(createDailyPlan([item],[],NOW,1));
  const session=repository.getOrCreateInProgressSession("ja",plan.units,NOW,{mode:"today",dailyPlanId:plan.id});
  const introduced=repository.acknowledgeIntroduction(session.id,item.id,NOW);
  expect(introduced.plannedUnits[0].recallNotBefore).toBe("2026-10-03T06:03:00.000Z");
  const input={sessionId:session.id,learningItemId:item.id,ability:"recall" as const,exerciseId:"gap",exerciseType:"recall" as const,result:"correct" as const,usedHint:false,responseTimeMs:100,now:NOW};
  expect(()=>repository.recordGradedAttempt(input)).toThrow("稍後");
  expect(repository.recordGradedAttempt({...input,now:new Date(NOW.getTime()+180000)}).schedule.intervalDays).toBe(1);
});
it("major edits retain attempts and freeze the current question while resetting future evidence",()=>{
  const {repository,session}=setup();
  const first=session.plannedUnits[0];
  repository.editItem(first.learningItemId,1,{promptZh:"新版意思",answer:"新版答案"},NOW);
  const result=repository.recordGradedAttempt({sessionId:session.id,learningItemId:first.learningItemId,ability:first.ability,exerciseId:"old-question",exerciseType:first.ability,result:"correct",usedHint:false,responseTimeMs:100,now:NOW});
  expect(result.attempt.abilityEvidence?.question.answer).toBe(first.itemSnapshot?.answer);
  expect(repository.getItem(first.learningItemId)).toMatchObject({contentVersion:2,needsUnderstanding:true,answer:"新版答案"});
  expect(repository.getScheduleState(first.learningItemId,first.ability)).toBeUndefined();
  expect(result.attempt.abilityEvidence?.wasDue).toBe(false);
});
it("finishes an old-version introduction without enrolling or clearing the edited content",()=>{
  const repository=new MemoryLearningRepository();
  const item=repository.addItem({language:"ja",type:"vocabulary",promptZh:"狗",answer:"犬",source:"manual",tags:[]});
  const plan=repository.saveDailyPlan(createDailyPlan([item],[],NOW,1));
  const session=repository.getOrCreateInProgressSession("ja",plan.units,NOW,{mode:"today",dailyPlanId:plan.id});
  repository.editItem(item.id,1,{promptZh:"新版詞義",answer:"新版"},NOW);
  repository.acknowledgeIntroduction(session.id,item.id,NOW,true);
  const result=repository.recordGradedAttempt({sessionId:session.id,learningItemId:item.id,ability:"recall",exerciseId:"old_intro",exerciseType:"recall",result:"correct",usedHint:false,responseTimeMs:100,now:NOW});
  expect(result.session.status).toBe("completed");
  expect(repository.getItem(item.id)).toMatchObject({needsUnderstanding:true,status:"new"});
  expect(repository.listScheduleStates()).toEqual([]);
});
