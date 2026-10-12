import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { createAdminClient } from "../../lib/supabase/admin";
import { installMockLocalStorage } from "../../test/localStorageMock";
import { MemoryLearningRepository } from "../memoryRepository";
import { accountStorage, setAccountOwner, withDataLock } from "../accountStorage";
import { createEmptyStore, writePersistedStore } from "../schema";
import { createDailyPlan } from "../../domain/learningRules";
import { learningItemToRow, scheduleStateToRow, studySessionToRow, reviewAttemptToRow, enqueueOutboxEntry, listOutboxEntries, type LearningEventPayload } from "./outbox";
import { drainOutboxFully, __resetSyncEngineForTests, pullAndMergeRemoteData } from "./syncEngine";

try { if (process.env.RUN_REAL_TESTS === "1") process.loadEnvFile(".env.local"); } catch { /* Explicit opt-in only. */ }
const enabled = process.env.RUN_REAL_TESTS === "1" && !!(process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY);
(enabled ? describe : describe.skip)("modern learning events, isolated real account", () => {
  let admin: SupabaseClient;
  let client: SupabaseClient;
  let owner: string;
  beforeAll(async () => {
    installMockLocalStorage(); __resetSyncEngineForTests();
    admin=createAdminClient();
    const email=`learning-events-${crypto.randomUUID()}@example.com`;
    const password=`Test-${crypto.randomUUID()}-Aa1!`;
    const created=await admin.auth.admin.createUser({email,password,email_confirm:true});
    if(created.error || !created.data.user) throw new Error("Temporary test account creation failed");
    owner=created.data.user.id;
    client=createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? process.env.SUPABASE_URL!,process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,{auth:{persistSession:false,autoRefreshToken:false}});
    const signed=await client.auth.signInWithPassword({email,password});
    if(signed.error) throw new Error("Temporary test account login failed");
    setAccountOwner(owner);
  },30000);
  afterAll(async () => {
    await client?.auth.signOut();
    if(owner) { const removed=await admin.auth.admin.deleteUser(owner); if(removed.error) throw new Error("Temporary test account cleanup failed"); }
  },30000);
  it("rebases two concurrent due answers without double advancement and downloads over 1000 related attempts",async()=>{
    const now=new Date();
    const seed=new MemoryLearningRepository();
    const item=seed.addItem({language:"ja",type:"vocabulary",promptZh:"測試狗",answer:"犬",source:"manual",tags:[]});
    item.introducedAt=new Date(now.getTime()-3*86400000).toISOString(); item.status="learning";
    const baseline={learningItemId:item.id,ability:"recall" as const,language:"ja" as const,dueAt:new Date(now.getTime()-86400000).toISOString(),intervalDays:1,streak:1,lapseCount:0,lastReviewedAt:new Date(now.getTime()-2*86400000).toISOString(),ruleVersion:2 as const,evidenceStreak:0,recentFailures:0};
    for(const [rpc,payload] of [["upsert_learning_item_guarded",learningItemToRow(item,owner)],["upsert_schedule_state_guarded",scheduleStateToRow(baseline,owner)]] as const) {
      const saved=await client.rpc(rpc,{payload}); expect(saved.error).toBeNull();
    }
    const historyId=`history_${crypto.randomUUID()}`;
    const history={id:historyId,user_id:owner,language:"ja",status:"completed",started_at:baseline.lastReviewedAt,completed_at:baseline.lastReviewedAt,new_item_ids:[],review_item_ids:[item.id],planned_units:Array.from({length:1001},()=>({learningItemId:item.id,ability:"recall",kind:"review"}))};
    expect((await admin.from("study_sessions").insert(history)).error).toBeNull();
    const rows=Array.from({length:1001},(_,index)=>({id:`history_attempt_${crypto.randomUUID()}`,user_id:owner,session_id:historyId,sequence_in_session:index,exercise_id:`historical_${index}`,learning_item_id:item.id,language:"ja",exercise_type:"recall",result:"correct",used_hint:false,response_time_ms:1,reviewed_at:baseline.lastReviewedAt}));
    for(let from=0;from<rows.length;from+=400) expect((await admin.from("review_attempts").insert(rows.slice(from,from+400))).error).toBeNull();
    const unit={learningItemId:item.id,ability:"recall" as const,kind:"review" as const};
    const events:LearningEventPayload[]=[];
    const repositories:MemoryLearningRepository[]=[];
    for(let device=0;device<2;device++) {
      const repository=new MemoryLearningRepository({...createEmptyStore(),items:[item],scheduleStates:[baseline]});
      accountStorage().setItem("learning-language:device-id",`device_${device}`);
      const before=repository.getOrCreateInProgressSession("ja",[unit],now,{mode:"today"});
      expect((await client.rpc("upsert_study_session_guarded",{payload:studySessionToRow(before,owner)})).error).toBeNull();
      const after=repository.recordGradedAttempt({sessionId:before.id,learningItemId:item.id,ability:"recall",exerciseId:`answer_${device}`,exerciseType:"recall",result:"correct",usedHint:false,responseTimeMs:100,now,rawAnswer:"犬",normalizedAnswer:"犬"});
      events.push({id:`event_${crypto.randomUUID()}`,kind:"attempt",beforeSession:studySessionToRow(before,owner),session:studySessionToRow(after.session,owner),item:learningItemToRow(repository.getItem(item.id)!,owner),attempt:reviewAttemptToRow(after.attempt,0,owner),beforeSchedule:scheduleStateToRow(baseline,owner),schedule:scheduleStateToRow(after.schedule,owner)});
      repositories.push(repository);
    }
    expect((await client.rpc("commit_learning_event",{payload:events[0]})).error).toBeNull();
    expect((await client.rpc("commit_learning_event",{payload:events[1]})).error?.message).toContain("schedule_changed");
    const local=repositories[1];
    writePersistedStore({...createEmptyStore(),items:local.listItems(),scheduleStates:local.listScheduleStates(),reviewAttempts:local.listReviewAttempts(),studySessions:local.listStudySessions({status:"all"})});
    await withDataLock(()=>enqueueOutboxEntry({type:"learning_event",payload:events[1]}));
    const drained=await drainOutboxFully(client,undefined,owner);
    expect(drained.success).toBe(true);
    expect(listOutboxEntries()).toHaveLength(0);
    expect((await client.rpc("commit_learning_event",{payload:events[0]})).error).toBeNull();
    const schedule=await client.from("schedule_states").select("*").eq("learning_item_id",item.id).single();
    expect(schedule.data).toMatchObject({interval_days:3,learning_metadata:{evidenceStreak:1}});
    await pullAndMergeRemoteData(client,owner);
    const {readPersistedStore}=await import("../schema");
    const restored=readPersistedStore();
    expect(restored.reviewAttempts).toHaveLength(1003);
    expect(restored.studySessions.find(session=>session.id===historyId)?.exerciseResults).toHaveLength(1001);
    const plan=createDailyPlan(restored.items,restored.scheduleStates,now,0);
    expect((await client.rpc("reserve_daily_plan",{payload:plan})).data.newItemIds).toEqual([]);
  },60000);
});
