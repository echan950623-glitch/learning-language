import { expect, it } from "vitest";
import { replayLearningEvidence } from "./replayLearningEvidence";
import type { LearningItem, ReviewAttempt, ScheduleState } from "./types";
const now="2026-10-03T04:00:00.000Z";
const item:LearningItem={id:"i",language:"ja",type:"vocabulary",promptZh:"狗",answer:"犬",source:"manual",tags:[],status:"learning",isSeed:false,createdAt:now,contentVersion:1,introducedAt:now};
const baseline:ScheduleState={learningItemId:"i",language:"ja",ability:"recall",dueAt:now,intervalDays:1,streak:1,lapseCount:0,lastReviewedAt:"2026-10-02T04:00:00.000Z"};
function answer(id:string,reviewedAt:string,result:ReviewAttempt["result"]="correct",sessionId=id,attemptNumber=0):ReviewAttempt {
  return {id,exerciseId:id,learningItemId:"i",language:"ja",exerciseType:"recall",sessionId,result,usedHint:false,responseTimeMs:100,reviewedAt,
    abilityEvidence:{ruleVersion:2,mode:"today",attemptNumber,wasDue:true,introduced:true,day:reviewedAt.slice(0,10),timeZone:"Asia/Taipei",rawAnswer:result,normalizedAnswer:result,originalResult:result,question:structuredClone(item),beforeSchedule:structuredClone(baseline),corrections:[]}};
}
it("merges chronological offline events without advancing twice on the same day",()=>{
  const first=answer("a",now);
  const second=answer("b","2026-10-03T05:00:00.000Z");
  expect(replayLearningEvidence(item,[second,first],baseline)).toEqual(replayLearningEvidence(item,[first,second],baseline));
  expect(replayLearningEvidence(item,[second,first],baseline)).toMatchObject({streak:2,intervalDays:3,evidenceStreak:1,lapseCount:0});
});
it("keeps an earlier failure and a later recovery, excluding its bounded retest from lapse",()=>{
  const wrong=answer("a",now,"incorrect","s1");
  const retry=answer("b","2026-10-03T04:10:00.000Z","incorrect","s1",1);
  const recovered=answer("c","2026-10-04T04:00:00.000Z","correct","s2");
  expect(replayLearningEvidence(item,[recovered,retry,wrong],baseline)).toMatchObject({lapseCount:1,recentFailures:0,evidenceStreak:1,streak:1});
});
it("does not apply old content evidence to a major edit or mutate source events",()=>{
  const old=answer("a",now);
  const snapshot=structuredClone(old);
  expect(replayLearningEvidence({...item,contentVersion:2},[old],baseline)).toEqual(baseline);
  expect(old).toEqual(snapshot);
});
