import { PGlite } from "@electric-sql/pglite";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import { MemoryLearningRepository } from "../memoryRepository";
import { createDailyPlan } from "../../domain/learningRules";
import { getJapanesePracticeCatalog } from "../../domain/japanesePracticeCatalog";
import { practiceInput } from "../../domain/learningPractice";
import { getEnglishPracticeCatalog } from "../../domain/englishPracticeCatalog";
import { activeEnglishVariant } from "../../domain/englishPractice";
import { normalizeForComparison } from "../../domain/text";
import { setVocabularyPaused, requestVocabularyVerification } from "../vocabularyPause";
import { learningItemToRow, reviewAttemptToRow, scheduleStateToRow, studySessionToRow, type LearningEventPayload } from "./outbox";

// No .env, HTTP, Supabase client, real users, or external database connections.
const db = new PGlite();
const A = "00000000-0000-0000-0000-000000000001";
const B = "00000000-0000-0000-0000-000000000002";
beforeAll(async () => {
  await db.exec(`
    create role anon; create role authenticated; create role service_role bypassrls;
    create schema auth; create table auth.users(id uuid primary key);
    create function auth.uid() returns uuid language sql stable as
      $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
    create function auth.jwt() returns jsonb language sql stable as
      $$ select coalesce(nullif(current_setting('request.jwt.claims', true), ''), '{}')::jsonb $$;
    grant usage on schema auth to authenticated, anon;
    grant execute on function auth.uid(), auth.jwt() to authenticated, anon;
    insert into auth.users values ('${A}'), ('${B}');
  `);
  const directory = join(process.cwd(), "supabase", "migrations");
  for (const file of readdirSync(directory).filter(file => file.endsWith(".sql")).sort()) await db.exec(readFileSync(join(directory, file), "utf8"));
  await db.exec(`grant select, insert, update, delete on public.learning_items, public.schedule_states, public.study_sessions, public.review_attempts, public.user_preferences to authenticated;
    grant usage, select on all sequences in schema public to authenticated;
    insert into public.learning_items(id,user_id,language,type,prompt_zh,answer,source,status,created_at)
      values ('item_a','${A}','ja','vocabulary','狗','犬','manual','learning',now()),
             ('item_b','${B}','ja','vocabulary','貓','猫','manual','new',now());
    insert into public.schedule_states(user_id,learning_item_id,ability,language,due_at,interval_days,streak,lapse_count)
      values ('${A}','item_a','recall','ja',now(),1,1,0);
    insert into public.study_sessions(id,user_id,language,status,started_at,completed_at,planned_units)
      values ('session_a','${A}','ja','completed',now(),now(),'[{"learningItemId":"item_a","ability":"recall","kind":"review"}]');
    insert into public.review_attempts(id,user_id,session_id,sequence_in_session,exercise_id,learning_item_id,language,exercise_type,result,used_hint,response_time_ms,reviewed_at)
      values ('attempt_a','${A}','session_a',0,'ex_a','item_a','ja','recall','correct',false,100,now());
  `);
}, 30_000);
afterAll(async () => { await db.close(); });

it("the deployed SQL contracts accept fixed review stages and completion without schema changes", async () => {
  await db.exec("begin;");
  try {
    const repository = new MemoryLearningRepository(), start = new Date();
    const item = repository.addItem(getEnglishPracticeCatalog()[0]);
    await db.exec(`set role authenticated; select set_config('request.jwt.claim.sub','${B}',false);`);
    await db.query("select public.upsert_learning_item_guarded($1::jsonb)", [learningItemToRow(item, B)]);
    const plan = repository.saveDailyPlan(createDailyPlan([item], [], start, 5, false, undefined, undefined, [], "en"));
    await db.query("select public.reserve_daily_plan($1::jsonb)", [plan]);
    for (const [index, elapsed] of [0, 1, 4, 9, 16, 30].entries()) {
      const now = new Date(start.getTime() + elapsed * 86_400_000);
      let session = repository.getOrCreateInProgressSession("en", index === 0 ? plan.units : [{ learningItemId: item.id, ability: "meaning", kind: "review" }], now, { mode: "today", ...(index === 0 ? { dailyPlanId: plan.id, timeZone: plan.timeZone } : {}) });
      await db.query("select public.upsert_study_session_guarded($1::jsonb)", [studySessionToRow(session, B)]);
      if (index === 0) {
        const introduced = repository.acknowledgeIntroduction(session.id, item.id, now, true);
        await db.query("select public.commit_learning_event($1::jsonb)", [{ id: "fixed-review-intro", kind: "introduction", beforeSession: studySessionToRow(session, B), session: studySessionToRow(introduced, B), item: learningItemToRow(repository.getItem(item.id)!, B) }]);
        session = introduced;
      }
      const previous = repository.listScheduleStates({ language: "en" })[0];
      const variant = activeEnglishVariant(session.plannedUnits[0].itemSnapshot!)!;
      const rawAnswer = variant.choices.find(c => c.id === variant.correctChoiceId)!.text;
      const result = repository.recordGradedAttempt({ sessionId: session.id, learningItemId: item.id, ability: "meaning", exerciseType: "meaning", exerciseId: `fixed-review-${index}`, result: "correct", usedHint: false, responseTimeMs: 100, rawAnswer, normalizedAnswer: rawAnswer, now });
      const event: LearningEventPayload = { id: `fixed-review-event-${index}`, kind: "attempt", beforeSession: studySessionToRow(session, B), session: studySessionToRow(result.session, B), item: learningItemToRow(repository.getItem(item.id)!, B), attempt: reviewAttemptToRow(result.attempt, 0, B), beforeSchedule: previous ? scheduleStateToRow(previous, B) : null, schedule: scheduleStateToRow(result.schedule, B), ...(index === 0 ? { plan: repository.listDailyPlans()[0] } : {}) };
      await db.query("select public.commit_learning_event($1::jsonb)", [event]);
      await db.query("select public.commit_learning_event($1::jsonb)", [event]);
      const stored = (await db.query<{ learning_metadata: Record<string, unknown>; interval_days: number }>("select learning_metadata, interval_days from public.schedule_states where learning_item_id=$1 and ability='meaning'", [item.id])).rows[0];
      expect(stored.learning_metadata).toMatchObject({ reviewPolicy: 1, reviewStage: index, reviewCompleted: index === 5 });
      expect(stored.interval_days).toBe([1, 3, 5, 7, 14, 14][index]);
    }
  } finally { await db.exec("rollback;"); }
}, 30_000);

it("English meaning replays actual frozen questions, rejects forged answers, and keeps language reservations separate", async () => {
  await db.exec("begin;");
  try {
    const repository = new MemoryLearningRepository(), now = new Date();
    const item = repository.addItem(getEnglishPracticeCatalog()[0]);
    const ja = repository.addItem({language:"ja",type:"vocabulary",answer:"机",promptZh:"桌子",source:"manual",tags:[]});
    await db.exec(`set role authenticated; select set_config('request.jwt.claim.sub','${B}',false);`);
    await db.query("select public.upsert_learning_item_guarded($1::jsonb)",[learningItemToRow(item,B)]);
    await db.query("select public.upsert_learning_item_guarded($1::jsonb)",[learningItemToRow(ja,B)]);
    const plan = createDailyPlan([item],[],now,5,false,undefined,undefined,[],"en");
    const reserved = (await db.query<{reserve_daily_plan:typeof plan}>("select public.reserve_daily_plan($1::jsonb)",[plan])).rows[0].reserve_daily_plan;
    expect(reserved.newItemIds).toContain(item.id);
    expect(reserved.language).toBe("en");
    await expect(db.query("select public.reserve_daily_plan($1::jsonb)",[{...plan,units:[{learningItemId:ja.id,ability:"meaning",kind:"new"}]}])).rejects.toThrow("plan_item_language_mismatch");
    // A rejected statement must not leave the outer test transaction aborted.
  } finally { await db.exec("rollback;"); }
});

it("English classified imports and atomic events preserve IDs, snapshots, metadata and idempotent results", async () => {
  await db.exec("begin;");
  async function rejects(sql:string, payload:unknown, message?:string) {
    await db.exec("savepoint rejected_statement;");
    if(message) await expect(db.query(sql,[payload])).rejects.toThrow(message);
    else await expect(db.query(sql,[payload])).rejects.toThrow();
    await db.exec("rollback to savepoint rejected_statement;");
  }
  try {
  const repository = new MemoryLearningRepository(), now = new Date();
  const item = repository.addItem(getEnglishPracticeCatalog()[0]);
  await db.exec(`set role authenticated; select set_config('request.jwt.claim.sub','${B}',false);`);
  await db.query("select public.upsert_learning_item_guarded($1::jsonb)",[learningItemToRow(item,B)]);
  const plan = repository.saveDailyPlan(createDailyPlan([item],[],now,5,false,undefined,undefined,[],"en"));
  await db.query("select public.reserve_daily_plan($1::jsonb)",[plan]);
  const initial = repository.getOrCreateInProgressSession("en",plan.units,now,{mode:"today",dailyPlanId:plan.id,timeZone:plan.timeZone});
  await db.query("select public.upsert_study_session_guarded($1::jsonb)",[studySessionToRow(initial,B)]);
  const introduced = repository.acknowledgeIntroduction(initial.id,item.id,now,true);
  const intro = {id:"english-introduction",kind:"introduction",beforeSession:studySessionToRow(initial,B),session:studySessionToRow(introduced,B),item:learningItemToRow(repository.getItem(item.id)!,B)};
  await db.query("select public.commit_learning_event($1::jsonb)",[intro]);
  const question = initial.plannedUnits[0].itemSnapshot!;
  const v = activeEnglishVariant(question)!;
  const rawAnswer = v.choices.find(c=>c.id===v.correctChoiceId)!.text;
  const result = repository.recordGradedAttempt({sessionId:initial.id,learningItemId:item.id,ability:"meaning",exerciseType:"meaning",exerciseId:"english-actual",result:"correct",usedHint:false,responseTimeMs:200,rawAnswer,normalizedAnswer:normalizeForComparison(rawAnswer),now});
  const event:LearningEventPayload = {id:"english-answer",kind:"attempt",beforeSession:studySessionToRow(introduced,B),session:studySessionToRow(result.session,B),item:learningItemToRow(repository.getItem(item.id)!,B),attempt:reviewAttemptToRow(result.attempt,0,B),beforeSchedule:null,schedule:scheduleStateToRow(result.schedule,B),plan:repository.listDailyPlans()[0]};
  const forged = structuredClone(event);forged.id="english-forged";forged.attempt!.learning_metadata!.rawAnswer="incorrect-choice";
  await rejects("select public.commit_learning_event($1::jsonb)",forged,"english_answer_mismatch");
  expect((await db.query("select * from public.review_attempts where learning_item_id=$1",[item.id])).rows).toEqual([]);
  await db.query("select public.commit_learning_event($1::jsonb)",[event]);
  expect((await db.query<{commit_learning_event:{replayed:boolean}}>("select public.commit_learning_event($1::jsonb)",[event])).rows[0].commit_learning_event.replayed).toBe(true);
  const saved = (await db.query<{id:string;learning_metadata:typeof result.attempt.abilityEvidence}>("select id,learning_metadata from public.review_attempts where id=$1",[result.attempt.id])).rows[0];
  expect(saved.id).toBe(result.attempt.id);expect(saved.learning_metadata?.question).toEqual(question);
  const imported = {...scheduleStateToRow(result.schedule,B),learning_item_id:item.id};
  // Delete only this isolated test's rows to exercise fresh classified INSERT paths, not just idempotent existing-row returns.
  await db.query("delete from public.schedule_states where learning_item_id=$1",[item.id]);
  await db.query("delete from public.review_attempts where id=$1",[result.attempt.id]);
  await db.query("select public.upsert_schedule_state_guarded($1::jsonb)",[imported]);
  await db.query("select public.upsert_review_attempt_guarded($1::jsonb)",[event.attempt]);
  expect((await db.query<{learning_metadata:unknown}>("select learning_metadata from public.review_attempts where id=$1",[result.attempt.id])).rows[0].learning_metadata).toEqual(result.attempt.abilityEvidence);
  await rejects("select public.upsert_schedule_state_guarded($1::jsonb)",{...imported,ability:"recall"},"english_ability_mismatch");
  await rejects("select public.upsert_study_session_guarded($1::jsonb)",{...studySessionToRow(initial,B),id:"en-wrong-language",language:"ja"});
  await db.exec(`select set_config('request.jwt.claim.sub','${A}',false);`);
  await rejects("select public.commit_learning_event($1::jsonb)",event);
  } finally { await db.exec("rollback;"); }
});
it("replays automatic-verification requests idempotently and retains their question snapshots without fabricating evidence", async () => {
  await db.exec("begin;");
  try {
    const repository = new MemoryLearningRepository(), now = new Date("2026-10-11T08:00:00.000Z");
    const item = repository.addItem({ language: "ja", type: "vocabulary", promptZh: "預約", answer: "予約", reading: "よやく", source: "manual", tags: [] });
    await db.exec(`set role authenticated; select set_config('request.jwt.claim.sub','${B}',false);`);
    await db.query("select public.upsert_learning_item_guarded($1::jsonb)", [learningItemToRow(item, B)]);
    const session = repository.getOrCreateInProgressSession("ja", [{ learningItemId: item.id, ability: "recall", kind: "review" }], now, { mode: "full" });
    await db.query("select public.upsert_study_session_guarded($1::jsonb)", [studySessionToRow(session, B)]);
    const after = requestVocabularyVerification(repository, session.id, 0, item.id, now);
    const skip = { id: "auto_check_skip", kind: "skip", beforeSession: studySessionToRow(session, B), session: studySessionToRow(after, B) };
    const edit = { id: "auto_check_edit", kind: "edit", beforeItem: learningItemToRow(item, B), item: learningItemToRow(repository.getItem(item.id)!, B), beforeSchedules: [], schedules: [] };
    for (const payload of [skip, edit]) {
      await db.query("select public.commit_learning_event($1::jsonb)", [payload]);
      expect((await db.query<{ commit_learning_event: { replayed: boolean } }>("select public.commit_learning_event($1::jsonb)", [payload])).rows[0].commit_learning_event.replayed).toBe(true);
    }
    expect((await db.query<{ learning_metadata: { autoVerificationRequestedAt: string } }>("select learning_metadata from public.learning_items where id=$1", [item.id])).rows[0].learning_metadata.autoVerificationRequestedAt).toBe(now.toISOString());
    expect((await db.query("select * from public.review_attempts where learning_item_id=$1", [item.id])).rows).toEqual([]);
    expect((await db.query("select * from public.schedule_states where learning_item_id=$1", [item.id])).rows).toEqual([]);
    const tomorrow = new Date("2026-10-12T08:00:00.000Z");
    const check = repository.getOrCreateInProgressSession("ja", [{ learningItemId: item.id, ability: "recall", kind: "review" }], tomorrow, { mode: "full" });
    expect(check.plannedUnits[0].itemSnapshot?.verificationQuestion).toMatchObject({ kind: "context", novel: true });
    await db.query("select public.upsert_study_session_guarded($1::jsonb)", [studySessionToRow(check, B)]);
    const result = repository.recordGradedAttempt({ sessionId: check.id, learningItemId: item.id, ability: "recall", exerciseId: "auto_actual_sql", exerciseType: "recall", result: "correct", usedHint: false, responseTimeMs: 100, rawAnswer: "予約", normalizedAnswer: "予約", now: tomorrow });
    const payload: LearningEventPayload = { id: "auto_actual_sql_event", kind: "attempt", beforeSession: studySessionToRow(check, B), session: studySessionToRow(result.session, B), item: learningItemToRow(repository.getItem(item.id)!, B), attempt: reviewAttemptToRow(result.attempt, 0, B), beforeSchedule: null, schedule: null };
    await db.query("select public.commit_learning_event($1::jsonb)", [payload]);
    await db.query("select public.commit_learning_event($1::jsonb)", [payload]);
    expect((await db.query<{ learning_metadata: unknown }>("select learning_metadata from public.review_attempts where exercise_id='auto_actual_sql'")).rows).toEqual([{ learning_metadata: result.attempt.abilityEvidence }]);
  } finally { await db.exec("rollback;"); }
});
it("replays pause and resume through the existing edit RPC without changing schedules or attempts", async () => {
  await db.exec("begin;");
  try {
    const repository = new MemoryLearningRepository(), now = new Date();
    const item = repository.addItem({ language: "ja", type: "vocabulary", promptZh: "暫停測試", answer: "休む", source: "manual", tags: [] });
    await db.exec(`set role authenticated; select set_config('request.jwt.claim.sub','${B}',false);`);
    await db.query("select public.upsert_learning_item_guarded($1::jsonb)", [learningItemToRow(item, B)]);
    const schedules = await db.query("select * from public.schedule_states where user_id=$1", [B]);
    const attempts = await db.query("select * from public.review_attempts where user_id=$1", [B]);
    for (const paused of [true, false]) {
      const before = repository.getItem(item.id)!;
      const after = setVocabularyPaused(repository, item.id, paused, now);
      const payload = { id: `pause_sql_${paused}`, kind: "edit", beforeItem: learningItemToRow(before, B), item: learningItemToRow(after, B), beforeSchedules: [], schedules: [] };
      await db.query("select public.commit_learning_event($1::jsonb)", [payload]);
      await db.query("select public.commit_learning_event($1::jsonb)", [payload]);
      expect((await db.query<{ paused: boolean }>("select (learning_metadata->>'reviewPaused')::boolean as paused from public.learning_items where id=$1", [item.id])).rows).toEqual([{ paused }]);
      expect((await db.query("select * from public.schedule_states where user_id=$1", [B])).rows).toEqual(schedules.rows);
      expect((await db.query("select * from public.review_attempts where user_id=$1", [B])).rows).toEqual(attempts.rows);
    }
  } finally { await db.exec("rollback; reset role;"); }
});
it("skips vocabulary through SQL without scoring, preserves due dates, and replays exactly once", async () => {
  await db.exec("begin;");
  try {
    const repository = new MemoryLearningRepository(); const now = new Date();
    const item = repository.addItem({ language: "ja", type: "vocabulary", promptZh: "狗", answer: "犬", reading: "いぬ", source: "manual", tags: [] });
    await db.exec(`set role authenticated; select set_config('request.jwt.claim.sub','${B}',false);`);
    await db.query("select public.upsert_learning_item_guarded($1::jsonb)", [learningItemToRow(item, B)]);
    await db.query("insert into public.schedule_states(user_id,learning_item_id,ability,language,due_at,interval_days,streak,lapse_count) values($1,$2,'recall','ja',$3,7,2,1)", [B,item.id,now.toISOString()]);
    const session = repository.getOrCreateInProgressSession("ja", [{ learningItemId: item.id, ability: "recall", kind: "review" }, { learningItemId: item.id, ability: "reading", kind: "review" }], now, { mode: "full" });
    await db.query("select public.upsert_study_session_guarded($1::jsonb)", [studySessionToRow(session, B)]);
    const before = await db.query("select * from public.schedule_states where user_id=$1", [B]);
    const after = repository.skipVocabulary(session.id, 0, item.id, now);
    const payload = { id: "skip_sql_event", kind: "skip", beforeSession: studySessionToRow(session, B), session: studySessionToRow(after, B) };
    await db.exec("savepoint forged_skip;");
    await expect(db.query("select public.commit_learning_event($1::jsonb)", [{ ...payload, session: { ...payload.session, planned_units: session.plannedUnits.slice(1) } }])).rejects.toThrow("invalid_skip_state");
    await db.exec("rollback to forged_skip;");
    await db.query("select public.commit_learning_event($1::jsonb)", [payload]);
    expect((await db.query<{ commit_learning_event: { replayed: boolean } }>("select public.commit_learning_event($1::jsonb)", [payload])).rows[0].commit_learning_event.replayed).toBe(true);
    expect((await db.query("select * from public.schedule_states where user_id=$1", [B])).rows).toEqual(before.rows);
    expect((await db.query("select * from public.review_attempts where session_id=$1", [session.id])).rows).toEqual([]);
    expect((await db.query("select status,planned_units from public.study_sessions where id=$1", [session.id])).rows).toEqual([{ status: "completed", planned_units: [] }]);
    await db.exec(`select set_config('request.jwt.claim.sub','${A}',false);`);
    await expect(db.query("select public.commit_learning_event($1::jsonb)", [payload])).rejects.toThrow("sync_auth_mismatch");
  } finally { await db.exec("rollback;"); }
});
it("persists a practice variant through the actual SQL event contract and retry without creating a schedule", async () => {
  await db.exec("begin;");
  try {
  const repository = new MemoryLearningRepository(); const now = new Date();
  const item = repository.addItem(practiceInput({ ...getJapanesePracticeCatalog().find(e => e.id === "form:te:production")!.practice, learned: true, enabled: true }));
  await db.exec(`set role authenticated; select set_config('request.jwt.claim.sub','${B}',false);`);
  await db.query("select public.upsert_learning_item_guarded($1::jsonb)", [learningItemToRow(item, B)]);
  const session = repository.getOrCreateInProgressSession("ja", [{ learningItemId: item.id, ability: "recall", kind: "review" }], now, { mode: "random" });
  await db.query("select public.upsert_study_session_guarded($1::jsonb)", [studySessionToRow(session, B)]);
  const result = repository.recordGradedAttempt({ sessionId: session.id, learningItemId: item.id, ability: "recall", exerciseId: "practice_sql_ex", exerciseType: "recall", result: "correct", usedHint: false, responseTimeMs: 100, rawAnswer: "はらって", normalizedAnswer: "はらって", now });
  const payload: LearningEventPayload = { id: "practice_sql_event", kind: "attempt", beforeSession: studySessionToRow(session, B), session: studySessionToRow(result.session, B), item: learningItemToRow(repository.getItem(item.id)!, B), attempt: reviewAttemptToRow(result.attempt, 0, B), beforeSchedule: null, schedule: null };
  await db.query("select public.commit_learning_event($1::jsonb)", [payload]);
  await db.query("select public.commit_learning_event($1::jsonb)", [payload]);
  expect((await db.query<{ learning_metadata: unknown }>("select learning_metadata from public.review_attempts where exercise_id='practice_sql_ex'")).rows).toEqual([{ learning_metadata: result.attempt.abilityEvidence }]);
  expect((await db.query("select * from public.schedule_states where learning_item_id=$1", [item.id])).rows).toEqual([]);
  await db.exec("savepoint legacy_attempt;");
  await expect(db.query(`insert into public.review_attempts(id,user_id,session_id,sequence_in_session,exercise_id,learning_item_id,language,exercise_type,result,used_hint,response_time_ms,reviewed_at)
    select 'old_practice',user_id,session_id,1,'old_practice_ex',learning_item_id,language,exercise_type,result,used_hint,response_time_ms,reviewed_at from public.review_attempts where exercise_id='practice_sql_ex'`)).rejects.toThrow("practice_requires_classified_evidence");
  await db.exec("rollback to legacy_attempt;");
  const report = repository.addItem({ language: "ja", type: "phrase", promptZh: "教練摘要", answer: "sql-report-1", source: "ai", tags: [], coachReport: { version: 1, externalId: "sql-report-1", practicedAt: now.toISOString(), source: "gpt", summary: "有協助", observations: [] } });
  await db.query("select public.upsert_learning_item_guarded($1::jsonb)", [learningItemToRow(report, B)]);
  await db.exec("savepoint report_score;");
  await expect(db.query(`insert into public.schedule_states(user_id,learning_item_id,ability,language,due_at,interval_days,streak,lapse_count) values($1,$2,'recall','ja',now(),1,1,0)`, [B, report.id])).rejects.toThrow("coach_observation_cannot_be_scored");
  await db.exec("rollback to report_score;");
  } finally { await db.exec("rollback; reset role;"); }
});

it("allows Auth account cascade cleanup without recreating a foreign-key revision", async () => {
  const owner="00000000-0000-0000-0000-000000000003";
  await db.exec(`reset role; select set_config('request.jwt.claim.sub','',false); insert into auth.users values ('${owner}'); insert into public.learning_items(id,user_id,language,type,prompt_zh,answer,source,status,created_at) values('cleanup_item','${owner}','ja','vocabulary','刪除測試','削除','manual','new',now()); delete from auth.users where id='${owner}';`);
  expect((await db.query("select * from public.learning_data_revisions where user_id=$1",[owner])).rows).toEqual([]);
});

it("executes every migration in local PostgreSQL and archives progress without removing history", async () => {
  await db.exec(`set role authenticated; select set_config('request.jwt.claim.sub','${A}',false);`);
  await db.query("select public.delete_learning_items_guarded($1::jsonb)", [{ ids: ["item_a"] }]);
  await db.query("select public.archive_learning_items_guarded($1::jsonb)", [{ ids: ["item_a"], archivedAt: "2026-10-03T00:00:00Z" }]);
  expect((await db.query<{ count: number }>("select count(*)::integer as count from public.review_attempts")).rows[0].count).toBe(1);
  expect((await db.query<{ count: number }>("select count(*)::integer as count from public.schedule_states")).rows[0].count).toBe(1);
  expect((await db.query<{ archived_at: unknown }>("select archived_at from public.learning_items where id='item_a'")).rows[0].archived_at).toBeTruthy();
  await db.exec("reset role;");
});
it("RLS hides the other account and prevents client revision rewrites", async () => {
  await db.exec(`set role authenticated; select set_config('request.jwt.claim.sub','${B}',false);`);
  expect((await db.query("select id from public.learning_items")).rows).toEqual([{ id: "item_b" }]);
  await expect(db.query("update public.learning_data_revisions set revision=0")).rejects.toThrow(/permission denied/);
  const before = (await db.query<{ revision: string }>("select public.get_learning_revision() as revision")).rows[0].revision;
  await db.exec("update public.learning_items set explanation='updated' where id='item_b';");
  const after = (await db.query<{ revision: string }>("select public.get_learning_revision() as revision")).rows[0].revision;
  expect(BigInt(after)).toBe(BigInt(before) + BigInt(1));
  await db.exec("reset role;");
});
it("MCP cannot archive content or call the private revision trigger function", async () => {
  await db.exec(`set role authenticated; select set_config('request.jwt.claim.sub','${B}',false); select set_config('request.jwt.claims','{"client_id":"test_mcp"}',false);`);
  await expect(db.query("select public.archive_learning_items_guarded($1::jsonb)", [{ ids: ["item_b"] }])).rejects.toThrow("mcp_write_forbidden");
  await expect(db.query("select learning_internal.bump_learning_revision()")).rejects.toThrow();
  await db.exec("reset role; select set_config('request.jwt.claims','{}',false);");
});

it("reserves one shared daily quota and commits modern learning events exactly once", async () => {
  const repository = new MemoryLearningRepository();
  const now = new Date();
  const items = Array.from({ length: 7 }, (_, index) => repository.addItem({ language: "ja", type: "vocabulary", promptZh: `字 ${index}`, answer: `語${index}`, source: "manual", tags: [] }));
  await db.exec(`set role authenticated; select set_config('request.jwt.claim.sub','${B}',false);`);
  for (const item of items) await db.query("select public.upsert_learning_item_guarded($1::jsonb)", [learningItemToRow(item, B)]);
  const requested = createDailyPlan(items, [], now, 5);
  const reserved = (await db.query<{ plan: typeof requested }>("select public.reserve_daily_plan($1::jsonb) as plan", [requested])).rows[0].plan;
  expect(reserved.newItemIds).toHaveLength(5);
  const otherDevice = { ...requested, newItemIds: items.slice(2).map(item => item.id) };
  const second = (await db.query<{ plan: typeof requested }>("select public.reserve_daily_plan($1::jsonb) as plan", [otherDevice])).rows[0].plan;
  expect(second.newItemIds).toEqual(reserved.newItemIds);
  repository.saveDailyPlan(reserved);
  const before = repository.getOrCreateInProgressSession("ja", reserved.units, now, { mode: "today", dailyPlanId: reserved.id });
  await db.query("select public.upsert_study_session_guarded($1::jsonb)", [studySessionToRow(before, B)]);
  const itemId = before.plannedUnits[0].learningItemId;
  const introduced = repository.acknowledgeIntroduction(before.id, itemId, now);
  await db.query("select public.commit_learning_event($1::jsonb)", [{ id: "introduce_event", kind: "introduction", beforeSession: studySessionToRow(before, B), session: studySessionToRow(introduced, B), item: learningItemToRow(repository.getItem(itemId)!, B) } satisfies LearningEventPayload]);
  const result = repository.recordGradedAttempt({ sessionId: before.id, learningItemId: itemId, ability: "recall", exerciseId: "modern_ex", exerciseType: "recall", result: "correct", usedHint: false, responseTimeMs: 100, now, rawAnswer: "原始輸入", normalizedAnswer: "原始輸入" });
  const event: LearningEventPayload = { id: "answer_event", kind: "attempt", beforeSession: studySessionToRow(introduced, B), session: studySessionToRow(result.session, B),
    item: learningItemToRow(repository.getItem(itemId)!, B), attempt: reviewAttemptToRow(result.attempt, 0, B), beforeSchedule: null, schedule: scheduleStateToRow(result.schedule, B), plan: repository.listDailyPlans()[0] };
  await db.query("select public.commit_learning_event($1::jsonb)", [event]);
  await db.query("select public.commit_learning_event($1::jsonb)", [event]);
  const attempts = await db.query<{ learning_metadata: unknown }>("select learning_metadata from public.review_attempts where exercise_id='modern_ex'");
  expect(attempts.rows).toHaveLength(1);
  expect(attempts.rows[0].learning_metadata).toEqual(result.attempt.abilityEvidence);
  const schedules = await db.query<{ learning_metadata: unknown }>("select learning_metadata from public.schedule_states where learning_item_id=$1", [itemId]);
  expect(schedules.rows).toHaveLength(1);
  expect(schedules.rows[0].learning_metadata).toMatchObject({ ruleVersion: 2, evidenceStreak: 0 });
  await expect(db.query("select public.commit_learning_event($1::jsonb)", [{ ...event, attempt: { ...event.attempt, result: "incorrect" } }])).rejects.toThrow("event_payload_changed");
  let active = result.session;
  let sequence = 1;
  while (active.status === "in_progress") {
    const unit = active.plannedUnits[active.exerciseResults.length];
    if (unit.requiresIntroduction && !active.understoodItemIds?.includes(unit.learningItemId)) {
      const understood = repository.acknowledgeIntroduction(active.id,unit.learningItemId,now,true);
      await db.query("select public.commit_learning_event($1::jsonb)",[{id:`sql_intro_${sequence}`,kind:"introduction",beforeSession:studySessionToRow(active,B),session:studySessionToRow(understood,B),item:learningItemToRow(repository.getItem(unit.learningItemId)!,B)} satisfies LearningEventPayload]);
      active=understood;
    }
    const previous = repository.listScheduleStates().find(schedule => schedule.learningItemId === unit.learningItemId && schedule.ability === unit.ability);
    const next = repository.recordGradedAttempt({ sessionId: active.id, learningItemId: unit.learningItemId, ability: unit.ability, exerciseId: `sql_round_${sequence}`, exerciseType: unit.ability, result: sequence === 1 || (unit.attemptNumber ?? 0) > 0 ? "incorrect" : "correct", usedHint: false, responseTimeMs: 100, now });
    const payload: LearningEventPayload = { id: `sql_answer_${sequence}`, kind: "attempt", beforeSession: studySessionToRow(active,B), session: studySessionToRow(next.session,B), item: learningItemToRow(repository.getItem(unit.learningItemId)!,B), attempt: reviewAttemptToRow(next.attempt,sequence,B), beforeSchedule: previous ? scheduleStateToRow(previous,B) : null, schedule: scheduleStateToRow(next.schedule,B), plan:repository.listDailyPlans()[0] };
    await db.query("select public.commit_learning_event($1::jsonb)",[payload]);
    await db.query("select public.commit_learning_event($1::jsonb)",[payload]);
    active=next.session;
    sequence++;
  }
  expect(active.exerciseResults.some(result => result.attemptNumber === 1)).toBe(true);
  expect(repository.listScheduleStates().every(schedule => schedule.lapseCount <= 1)).toBe(true);
  const oldItem=repository.getItem(itemId)!;
  const oldSchedules=repository.listScheduleStates().filter(schedule=>schedule.learningItemId===itemId);
  const edited=repository.editItem(itemId,1,{promptZh:"新詞義",answer:"新版答案",reading:"しんばん"},now);
  const editEvent:LearningEventPayload={id:"edit_event",kind:"edit",beforeItem:learningItemToRow(oldItem,B),item:learningItemToRow(edited,B),beforeSchedules:oldSchedules.map(schedule=>scheduleStateToRow(schedule,B)),schedules:repository.listScheduleStates().filter(schedule=>schedule.learningItemId===itemId).map(schedule=>scheduleStateToRow(schedule,B))};
  await db.query("select public.commit_learning_event($1::jsonb)",[editEvent]);
  await db.query("select public.commit_learning_event($1::jsonb)",[editEvent]);
  expect((await db.query<{answer:string}>("select answer from public.learning_items where id=$1",[itemId])).rows[0].answer).toBe("新版答案");
  expect((await db.query<{learning_metadata:{question:{answer:string}}}>("select learning_metadata from public.review_attempts where exercise_id='modern_ex'")).rows[0].learning_metadata.question.answer).toBe(oldItem.answer);
  expect((await db.query<{streak:number}>("select streak from public.schedule_states where learning_item_id=$1",[itemId])).rows[0].streak).toBe(0);
  await expect(db.query("select public.commit_learning_event($1::jsonb)",[{...editEvent,id:"wrong_owner",item:{...editEvent.item,user_id:A}}])).rejects.toThrow("sync_auth_mismatch");
  await db.exec("reset role;");
});
