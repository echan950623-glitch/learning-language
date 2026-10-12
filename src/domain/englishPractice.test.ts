import { describe, expect, it } from "vitest";
import { getEnglishPracticeCatalog } from "./englishPracticeCatalog";
import { activeEnglishVariant, englishEvidence, englishModeVerified, englishStatus, freezeEnglishQuestion, isEnglishPractice } from "./englishPractice";
import { MemoryLearningRepository } from "../repository/memoryRepository";
import { createDailyPlan } from "./learningRules";
import { requiredAbilities } from "./abilities";
import { buildExerciseForUnit } from "./exercises";
import { normalizeForComparison } from "./text";
import { practiceChoices, choiceIsAssisted } from "./practicePresentation";
import { initializeStudySession } from "../app/study/sessionInit";
import { isDailyPlan, isStudySession, sanitizeStore } from "../repository/schema";
import { learningItemToRow, rowToLearningItem, reviewAttemptToRow, rowToReviewAttempt, studySessionToRow, rowToStudySessionShell } from "../repository/sync/outbox";
import { validateVocabularyBatch } from "../lib/mcp/tools/vocabularyBatchShared";
import { inputSchema as previewSchema, handler as preview } from "../lib/mcp/tools/previewVocabularyBatch";
import type { ReviewAttempt } from "./types";
import type { SupabaseClient } from "@supabase/supabase-js";
const now = new Date("2026-10-12T08:00:00.000Z");
const fake = {from:()=>({select:()=>({in:async()=>({data:[],error:null})})})} as unknown as SupabaseClient;
function setup() {
  const repo = new MemoryLearningRepository();
  const item = repo.addItem(getEnglishPracticeCatalog()[0]);
  return {repo,item};
}
describe("English content and session evidence", () => {
  it("ships 30 original senses and 150 complete questions; invalid answers and target mismatches fail closed", () => {
    const catalog = getEnglishPracticeCatalog();
    expect(catalog).toHaveLength(30);
    expect(catalog.flatMap(i=>i.englishPractice!.variants)).toHaveLength(150);
    expect(catalog.filter(i=>i.type==="vocabulary")).toHaveLength(20);
    for(const item of catalog) expect(isEnglishPractice(item.englishPractice), item.answer).toBe(true);
    const repository = new MemoryLearningRepository();
    expect(()=>repository.addItem({...catalog[0],type:"grammar"})).toThrow();
    expect(()=>repository.addItem({...catalog[0],partOfSpeech:undefined})).toThrow();
    const bad = structuredClone(catalog[0].englishPractice!);
    bad.variants[1].targetText = "missing-word";
    expect(isEnglishPractice(bad)).toBe(false);
    bad.variants[1] = structuredClone(catalog[0].englishPractice!.variants[1]);
    bad.variants[1].correctChoiceId = "missing";
    expect(isEnglishPractice(bad)).toBe(false);
    const duplicate = structuredClone(catalog[0].englishPractice!);
    duplicate.variants[2] = {...structuredClone(duplicate.variants[1]),id:"renamed",choices:[...duplicate.variants[1].choices].reverse()};
    expect(isEnglishPractice(duplicate)).toBe(false); // Renaming/reordering does not make a different context.
  });
  it("preserves all variants in MCP preview and rejects invalid items separately", async () => {
    const catalog = getEnglishPracticeCatalog();
    const parsed = previewSchema.parse({items:catalog});
    expect((await preview(fake, parsed)).validItems[0].englishPractice).toEqual(catalog[0].englishPractice);
    const invalid = structuredClone(parsed.items[1]);
    invalid.englishPractice!.variants![0].correctChoiceId = "missing";
    const result = await validateVocabularyBatch(fake, [parsed.items[0],invalid,parsed.items[0],{...parsed.items[0],promptZh:"另一個指定詞義",englishPractice:{...parsed.items[0].englishPractice!,senseKey:"other"}}]);
    expect(result.errors).toHaveLength(1);expect(result.duplicates).toHaveLength(1);expect(result.validItems).toHaveLength(2);
    expect((await validateVocabularyBatch(fake,[{...parsed.items[0],language:"ja"}])).errors).toHaveLength(1);
  });
  it("keeps Japanese and English plans/sessions apart and freezes the exact question across round-trip", () => {
    const {repo,item} = setup();
    const ja = repo.addItem({language:"ja",type:"vocabulary",answer:"犬",promptZh:"狗",source:"manual",tags:[]});
    expect(requiredAbilities(item)).toEqual(["meaning"]);
    const jp = repo.saveDailyPlan(createDailyPlan(repo.listItems(),[],now,5));
    const ep = repo.saveDailyPlan(createDailyPlan(repo.listItems(),[],now,5,false,undefined,undefined,[],"en"));
    expect(jp.newItemIds).toEqual([ja.id]);expect(ep.newItemIds).toEqual([item.id]);expect(isDailyPlan(ep)).toBe(true);
    const japaneseSession = repo.getOrCreateInProgressSession("ja",jp.units,now,{mode:"today",dailyPlanId:jp.id});
    const start = initializeStudySession(repo,now,10,5,ep,"en");
    if(start.phase!=="active")throw Error("no English session");
    expect(start.session.language).toBe("en");expect(isStudySession(start.session)).toBe(true);
    repo.acknowledgeIntroduction(start.session.id,item.id,now,true);
    const q = start.session.plannedUnits[0].itemSnapshot!;
    const exercise = buildExerciseForUnit(q,"meaning");
    expect(practiceChoices(q)).toHaveLength(4);
    expect(practiceChoices(q)).toContain(exercise.expectedAnswer);
    expect(choiceIsAssisted(q)).toBe(false); // Recognition is the actual target; choices aren't production evidence.
    expect(exercise.exerciseType).toBe("meaning");
    const result = repo.recordGradedAttempt({sessionId:start.session.id,learningItemId:item.id,ability:"meaning",exerciseType:"meaning",exerciseId:exercise.id,result:"correct",usedHint:false,responseTimeMs:500,rawAnswer:exercise.expectedAnswer,normalizedAnswer:normalizeForComparison(exercise.expectedAnswer),now});
    expect(rowToReviewAttempt(reviewAttemptToRow(result.attempt,0,"A"))).toEqual(result.attempt);
    expect({...rowToStudySessionShell(studySessionToRow(result.session,"A")),exerciseResults:result.session.exerciseResults}).toEqual(result.session);
    expect(rowToLearningItem(learningItemToRow(repo.getItem(item.id)!,"A"))).toEqual(repo.getItem(item.id));
    expect(result.attempt.abilityEvidence!.wasDue).toBe(false);
    expect(repo.listDailyPlans().find(p=>p.language==="ja")).toEqual(jp);
    expect(repo.getInProgressSession("ja")).toEqual(japaneseSession);
  });
  it("uses new contexts first, never relabels an exposed reserved question as novel", () => {
    const {item} = setup();
    const direct = freezeEnglishQuestion(item,[],[],false);
    const seenSession = {plannedUnits:[{itemSnapshot:direct}]} as unknown as Parameters<typeof freezeEnglishQuestion>[2][number];
    const verification = freezeEnglishQuestion(item,[],[seenSession],true);
    expect(activeEnglishVariant(verification)?.mode).toBe("context");
    expect(verification.verificationQuestion?.novel).toBe(true);
    const all = item.englishPractice!.variants.map(v=>({plannedUnits:[{itemSnapshot:{...item,englishPractice:{...item.englishPractice!,activeVariantId:v.id}}}]})) as unknown as Parameters<typeof freezeEnglishQuestion>[2];
    expect(freezeEnglishQuestion(item,[],all,true).verificationQuestion?.novel).toBe(false);
  });
  it("requires independent direct and context evidence, excludes hints/retries and changed content", () => {
    const {item} = setup();
    function attempt(mode:"direct"|"context",day:number,usedHint=false,attemptNumber=0):ReviewAttempt {
      const variants = item.englishPractice!.variants.filter(v=>v.mode===mode);
      const variant = variants[mode === "context" && day >= 7 ? 1 : 0];
      const date = new Date(now.getTime()+day*86400000).toISOString();
      return {id:`${mode}:${day}`,exerciseId:date,learningItemId:item.id,language:"en",exerciseType:"meaning",sessionId:date,result:"correct",usedHint,responseTimeMs:100,reviewedAt:date,abilityEvidence:{ruleVersion:2,mode:"today",attemptNumber,wasDue:true,introduced:true,day:date.slice(0,10),timeZone:"Asia/Taipei",rawAnswer:"",normalizedAnswer:"",originalResult:"correct",question:{...item,englishPractice:{...item.englishPractice!,activeVariantId:variant.id}},beforeSchedule:null,corrections:[]}};
    }
    const context = [attempt("context",0),attempt("context",7)];
    expect(englishModeVerified(item,context,"context")).toBe(true);
    expect(englishModeVerified(item,context,"direct")).toBe(false);
    const both = [...context,attempt("direct",1),attempt("direct",8)];
    expect(englishModeVerified(item,both,"direct")).toBe(true);
    expect(englishModeVerified(item,[...both,attempt("direct",9,true)],"direct")).toBe(false);
    expect(englishEvidence(item,[...both,attempt("direct",9,false,1)],"direct")).toHaveLength(2);
    expect(englishEvidence({...item,promptZh:"新的意思"},both)).toEqual([]);
    expect(englishStatus(item,[{learningItemId:item.id,language:"en",ability:"meaning",dueAt:now.toISOString(),intervalDays:1,streak:0,lapseCount:0}],both)).toBe("mastered");
  });
  it("restores full English structures in versioned backups without losing relationships", () => {
    const {repo,item}=setup();
    const session=repo.getOrCreateInProgressSession("en",[{learningItemId:item.id,ability:"meaning",kind:"new"}],now,{mode:"today"});
    const raw={schemaVersion:2,items:repo.listItems(),scheduleStates:[],reviewAttempts:[],studySessions:[session],dailyPlans:[]};
    expect(sanitizeStore(JSON.parse(JSON.stringify(raw))).store.items[0].englishPractice).toEqual(item.englishPractice);
    expect(sanitizeStore(JSON.parse(JSON.stringify(raw))).store.studySessions[0]).toEqual(session);
  });
  it("freezes the English new-word list within the day and rejects mismatched abilities without changing Japanese plans", () => {
    const {repo,item}=setup();
    const first = createDailyPlan(repo.listItems(),[],now,1,false,undefined,undefined,[],"en");
    const added = repo.addItem(getEnglishPracticeCatalog()[1]);
    const later = createDailyPlan(repo.listItems(),[],now,5,false,first,undefined,[],"en");
    expect(later.newItemIds).toEqual(first.newItemIds);
    expect(later.units.some(u=>u.learningItemId===added.id)).toBe(false);
    expect(()=>repo.getOrCreateInProgressSession("en",[{learningItemId:item.id,ability:"reading",kind:"new"}],now,{mode:"today"})).toThrow();
    expect(repo.listStudySessions({status:"all"})).toEqual([]);
  });
});
