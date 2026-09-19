-- Fail-closed guards for initial-import rows. SECURITY INVOKER preserves all existing RLS.
-- Existing rows are accepted only when every meaningful field is identical; divergent data
-- raises and stays in the client outbox for explicit resolution.

create or replace function public.upsert_schedule_state_guarded(payload jsonb)
returns jsonb language plpgsql security invoker set search_path = public, pg_temp as $$
declare v_uid uuid := auth.uid(); v_existing public.schedule_states%rowtype; v_result public.schedule_states%rowtype;
begin
  if v_uid is null or payload->>'user_id' is distinct from v_uid::text then raise exception 'sync_auth_mismatch'; end if;
  select * into v_existing from public.schedule_states
   where learning_item_id=payload->>'learning_item_id' and ability=payload->>'ability' and user_id=v_uid for update;
  if found then
    if v_existing.language is distinct from payload->>'language'
      or v_existing.due_at is distinct from (payload->>'due_at')::timestamptz
      or v_existing.interval_days is distinct from (payload->>'interval_days')::integer
      or v_existing.streak is distinct from (payload->>'streak')::integer
      or v_existing.lapse_count is distinct from (payload->>'lapse_count')::integer
      or v_existing.last_reviewed_at is distinct from (payload->>'last_reviewed_at')::timestamptz
    then raise exception 'sync_conflict:schedule_state'; end if;
    return to_jsonb(v_existing);
  end if;
  insert into public.schedule_states(user_id,learning_item_id,ability,language,due_at,interval_days,streak,lapse_count,last_reviewed_at)
  values(v_uid,payload->>'learning_item_id',payload->>'ability',payload->>'language',(payload->>'due_at')::timestamptz,
    (payload->>'interval_days')::integer,(payload->>'streak')::integer,(payload->>'lapse_count')::integer,
    (payload->>'last_reviewed_at')::timestamptz) returning * into v_result;
  return to_jsonb(v_result);
end $$;

create or replace function public.upsert_learning_item_guarded(payload jsonb)
returns jsonb language plpgsql security invoker set search_path = public, pg_temp as $$
declare v_uid uuid := auth.uid(); v_existing public.learning_items%rowtype; v_result public.learning_items%rowtype;
begin
  if v_uid is null or payload->>'user_id' is distinct from v_uid::text then raise exception 'sync_auth_mismatch'; end if;
  select * into v_existing from public.learning_items where id=payload->>'id' and user_id=v_uid for update;
  if found then
    if v_existing.language is distinct from payload->>'language' or v_existing.type is distinct from payload->>'type'
      or v_existing.prompt_zh is distinct from payload->>'prompt_zh' or v_existing.answer is distinct from payload->>'answer'
      or v_existing.reading is distinct from payload->>'reading' or v_existing.explanation is distinct from payload->>'explanation'
      or v_existing.romaji is distinct from payload->>'romaji' or v_existing.part_of_speech is distinct from payload->>'part_of_speech'
      or v_existing.example_sentence is distinct from payload->>'example_sentence' or v_existing.source is distinct from payload->>'source'
      or v_existing.tags is distinct from array(select jsonb_array_elements_text(payload->'tags'))
      or v_existing.status is distinct from payload->>'status' or v_existing.created_at is distinct from (payload->>'created_at')::timestamptz
      or v_existing.is_seed is distinct from (payload->>'is_seed')::boolean
    then raise exception 'sync_conflict:learning_item'; end if;
    return to_jsonb(v_existing);
  end if;
  insert into public.learning_items(id,user_id,language,type,prompt_zh,answer,reading,explanation,romaji,part_of_speech,example_sentence,source,tags,status,created_at,is_seed)
  values(payload->>'id',v_uid,payload->>'language',payload->>'type',payload->>'prompt_zh',payload->>'answer',payload->>'reading',
    payload->>'explanation',payload->>'romaji',payload->>'part_of_speech',payload->>'example_sentence',payload->>'source',
    array(select jsonb_array_elements_text(payload->'tags')),payload->>'status',(payload->>'created_at')::timestamptz,(payload->>'is_seed')::boolean)
  returning * into v_result;
  return to_jsonb(v_result);
end $$;

create or replace function public.delete_learning_items_guarded(payload jsonb)
returns integer language plpgsql security invoker set search_path = public, pg_temp as $$
declare v_uid uuid := auth.uid(); v_id text; v_deleted integer := 0;
begin
  if v_uid is null then raise exception 'sync_auth_mismatch'; end if;
  for v_id in select jsonb_array_elements_text(payload->'ids') loop
    perform 1 from public.learning_items where id=v_id and user_id=v_uid for update;
    if not found then continue; end if;
    if exists(select 1 from public.schedule_states where user_id=v_uid and learning_item_id=v_id)
      or exists(select 1 from public.review_attempts where user_id=v_uid and learning_item_id=v_id)
      or exists(select 1 from public.study_sessions where user_id=v_uid and (
        planned_units @> jsonb_build_array(jsonb_build_object('learningItemId',v_id))
        or v_id=any(new_item_ids) or v_id=any(review_item_ids)))
    then raise exception 'sync_conflict:delete_item_with_progress'; end if;
    delete from public.learning_items where id=v_id and user_id=v_uid;
    v_deleted := v_deleted + 1;
  end loop;
  return v_deleted;
end $$;

create or replace function public.abandon_study_session_guarded(payload jsonb)
returns jsonb language plpgsql security invoker set search_path = public, pg_temp as $$
declare v_uid uuid := auth.uid(); v_existing public.study_sessions%rowtype;
begin
  if v_uid is null then raise exception 'sync_auth_mismatch'; end if;
  select * into v_existing from public.study_sessions where id=payload->>'sessionId' and user_id=v_uid for update;
  if not found then raise exception 'sync_conflict:study_session_missing'; end if;
  if v_existing.status='completed' then raise exception 'sync_conflict:completed_session'; end if;
  if v_existing.status='in_progress' then
    update public.study_sessions set status='abandoned',updated_at=now()
      where id=v_existing.id and user_id=v_uid returning * into v_existing;
  end if;
  return to_jsonb(v_existing);
end $$;

create or replace function public.upsert_review_attempt_guarded(payload jsonb)
returns jsonb language plpgsql security invoker set search_path = public, pg_temp as $$
declare v_uid uuid := auth.uid(); v_existing public.review_attempts%rowtype; v_result public.review_attempts%rowtype;
begin
  if v_uid is null or payload->>'user_id' is distinct from v_uid::text then raise exception 'sync_auth_mismatch'; end if;
  select * into v_existing from public.review_attempts
   where user_id=v_uid and session_id=payload->>'session_id' and exercise_id=payload->>'exercise_id' for update;
  if found then
    if v_existing.sequence_in_session is distinct from (payload->>'sequence_in_session')::integer
      or v_existing.learning_item_id is distinct from payload->>'learning_item_id'
      or v_existing.language is distinct from payload->>'language'
      or v_existing.exercise_type is distinct from payload->>'exercise_type'
      or v_existing.result is distinct from payload->>'result'
      or v_existing.used_hint is distinct from (payload->>'used_hint')::boolean
      or v_existing.response_time_ms is distinct from (payload->>'response_time_ms')::integer
      or v_existing.reviewed_at is distinct from (payload->>'reviewed_at')::timestamptz
    then raise exception 'sync_conflict:review_attempt'; end if;
    return to_jsonb(v_existing);
  end if;
  insert into public.review_attempts(id,user_id,session_id,sequence_in_session,exercise_id,learning_item_id,language,exercise_type,result,used_hint,response_time_ms,reviewed_at)
  values(payload->>'id',v_uid,payload->>'session_id',(payload->>'sequence_in_session')::integer,payload->>'exercise_id',
    payload->>'learning_item_id',payload->>'language',payload->>'exercise_type',payload->>'result',
    (payload->>'used_hint')::boolean,(payload->>'response_time_ms')::integer,(payload->>'reviewed_at')::timestamptz)
  returning * into v_result;
  return to_jsonb(v_result);
end $$;

create or replace function public.upsert_study_session_guarded(payload jsonb)
returns jsonb language plpgsql security invoker set search_path = public, pg_temp as $$
declare v_uid uuid := auth.uid(); v_existing public.study_sessions%rowtype; v_result public.study_sessions%rowtype;
begin
  if v_uid is null or payload->>'user_id' is distinct from v_uid::text then raise exception 'sync_auth_mismatch'; end if;
  select * into v_existing from public.study_sessions where id=payload->>'id' and user_id=v_uid for update;
  if found then
    if v_existing.language is distinct from payload->>'language'
      or v_existing.status is distinct from payload->>'status'
      or v_existing.started_at is distinct from (payload->>'started_at')::timestamptz
      or v_existing.completed_at is distinct from (payload->>'completed_at')::timestamptz
      or v_existing.planned_units is distinct from payload->'planned_units'
      or v_existing.new_item_ids is distinct from array(select jsonb_array_elements_text(payload->'new_item_ids'))
      or v_existing.review_item_ids is distinct from array(select jsonb_array_elements_text(payload->'review_item_ids'))
    then raise exception 'sync_conflict:study_session'; end if;
    return to_jsonb(v_existing);
  end if;
  insert into public.study_sessions(id,user_id,language,status,started_at,completed_at,planned_units,new_item_ids,review_item_ids)
  values(payload->>'id',v_uid,payload->>'language',payload->>'status',(payload->>'started_at')::timestamptz,
    (payload->>'completed_at')::timestamptz,payload->'planned_units',
    array(select jsonb_array_elements_text(payload->'new_item_ids')),
    array(select jsonb_array_elements_text(payload->'review_item_ids'))) returning * into v_result;
  return to_jsonb(v_result);
end $$;

create or replace function public.upsert_preferences_guarded(payload jsonb)
returns jsonb language plpgsql security invoker set search_path = public, pg_temp as $$
declare v_uid uuid := auth.uid(); v_existing public.user_preferences%rowtype; v_result public.user_preferences%rowtype;
begin
  if v_uid is null or payload->>'user_id' is distinct from v_uid::text then raise exception 'sync_auth_mismatch'; end if;
  select * into v_existing from public.user_preferences where user_id=v_uid for update;
  if found then
    if v_existing.daily_question_count is distinct from (payload->>'daily_question_count')::integer
      or v_existing.daily_new_item_cap is distinct from (payload->>'daily_new_item_cap')::integer
    then raise exception 'sync_conflict:user_preferences'; end if;
    return to_jsonb(v_existing);
  end if;
  insert into public.user_preferences(user_id,daily_question_count,daily_new_item_cap)
  values(v_uid,(payload->>'daily_question_count')::integer,(payload->>'daily_new_item_cap')::integer)
  returning * into v_result;
  return to_jsonb(v_result);
end $$;

revoke all on function public.upsert_schedule_state_guarded(jsonb) from public, anon;
revoke all on function public.upsert_learning_item_guarded(jsonb) from public, anon;
revoke all on function public.delete_learning_items_guarded(jsonb) from public, anon;
revoke all on function public.abandon_study_session_guarded(jsonb) from public, anon;
revoke all on function public.upsert_review_attempt_guarded(jsonb) from public, anon;
revoke all on function public.upsert_study_session_guarded(jsonb) from public, anon;
revoke all on function public.upsert_preferences_guarded(jsonb) from public, anon;
grant execute on function public.upsert_schedule_state_guarded(jsonb) to authenticated;
grant execute on function public.upsert_learning_item_guarded(jsonb) to authenticated;
grant execute on function public.delete_learning_items_guarded(jsonb) to authenticated;
grant execute on function public.abandon_study_session_guarded(jsonb) to authenticated;
grant execute on function public.upsert_review_attempt_guarded(jsonb) to authenticated;
grant execute on function public.upsert_study_session_guarded(jsonb) to authenticated;
grant execute on function public.upsert_preferences_guarded(jsonb) to authenticated;

-- 日常作答也必須使用 compare-and-swap。舊函式保留在未暴露的 private schema，
-- 公開 RPC 先以 advisory transaction lock 序列化同一個 item/ability，再核對呼叫端
-- 作答前看到的排程。這樣兩台裝置同時更新不同 session 時，第二台不會覆蓋第一台。
create schema if not exists private;

alter function public.record_graded_attempt(jsonb) set schema private;
alter function private.record_graded_attempt(jsonb) rename to record_graded_attempt_legacy;
alter function public.mark_attempt_correct(jsonb) set schema private;
alter function private.mark_attempt_correct(jsonb) rename to mark_attempt_correct_legacy;

grant usage on schema private to authenticated, service_role;
revoke all on function private.record_graded_attempt_legacy(jsonb) from public, anon;
revoke all on function private.mark_attempt_correct_legacy(jsonb) from public, anon;
grant execute on function private.record_graded_attempt_legacy(jsonb) to authenticated, service_role;
grant execute on function private.mark_attempt_correct_legacy(jsonb) to authenticated, service_role;

create or replace function public.record_graded_attempt(payload jsonb)
returns jsonb
language plpgsql
security invoker
set search_path = public, private, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
  v_attempt public.review_attempts%rowtype;
  v_schedule public.schedule_states%rowtype;
  v_result jsonb;
  v_expected jsonb := payload->'expected_schedule';
  v_attempt_id text := payload->>'attempt_id';
  v_item_id text := payload->>'learning_item_id';
  v_ability text := payload->>'ability';
begin
  if v_uid is null then raise exception 'record_graded_attempt: 需要登入'; end if;

  -- 重送先走完整內容核對；即使排程已經由第一次成功呼叫改變，也能安全回傳。
  select * into v_attempt from public.review_attempts
   where user_id=v_uid and session_id=payload->>'session_id' and exercise_id=payload->>'exercise_id';
  if found then
    if (v_attempt_id is not null and v_attempt.id is distinct from v_attempt_id)
      or v_attempt.learning_item_id is distinct from v_item_id
      or v_attempt.exercise_type is distinct from payload->>'exercise_type'
      or v_attempt.result is distinct from payload->>'result'
      or v_attempt.used_hint is distinct from (payload->>'used_hint')::boolean
      or v_attempt.response_time_ms is distinct from (payload->>'response_time_ms')::integer
      or v_attempt.reviewed_at is distinct from (payload->>'reviewed_at')::timestamptz
    then raise exception 'sync_conflict:record_graded_attempt'; end if;

    select * into v_schedule from public.schedule_states
     where user_id=v_uid and learning_item_id=v_item_id and ability=v_ability;
    if not found
      or v_schedule.due_at is distinct from (payload->'schedule'->>'due_at')::timestamptz
      or v_schedule.interval_days is distinct from (payload->'schedule'->>'interval_days')::integer
      or v_schedule.streak is distinct from (payload->'schedule'->>'streak')::integer
      or v_schedule.lapse_count is distinct from (payload->'schedule'->>'lapse_count')::integer
    then raise exception 'sync_conflict:record_graded_attempt_retry'; end if;
    return private.record_graded_attempt_legacy(payload);
  end if;

  if v_attempt_id is null or not (payload ? 'expected_schedule') then
    raise exception 'sync_conflict:legacy_record_requires_review';
  end if;
  perform pg_advisory_xact_lock(hashtextextended(v_uid::text || ':' || v_item_id || ':' || v_ability, 0));
  select * into v_schedule from public.schedule_states
   where user_id=v_uid and learning_item_id=v_item_id and ability=v_ability;

  if v_expected = 'null'::jsonb then
    if found then raise exception 'sync_conflict:schedule_changed'; end if;
  else
    if not found
      or v_schedule.due_at is distinct from (v_expected->>'due_at')::timestamptz
      or v_schedule.interval_days is distinct from (v_expected->>'interval_days')::integer
      or v_schedule.streak is distinct from (v_expected->>'streak')::integer
      or v_schedule.lapse_count is distinct from (v_expected->>'lapse_count')::integer
      or v_schedule.last_reviewed_at is distinct from (v_expected->>'last_reviewed_at')::timestamptz
    then raise exception 'sync_conflict:schedule_changed'; end if;
  end if;

  v_result := private.record_graded_attempt_legacy(payload);
  update public.review_attempts set id=v_attempt_id
   where user_id=v_uid and session_id=payload->>'session_id' and exercise_id=payload->>'exercise_id';
  v_result := jsonb_set(v_result, '{attempt,id}', to_jsonb(v_attempt_id), false);
  return v_result;
end $$;

create or replace function public.mark_attempt_correct(payload jsonb)
returns jsonb
language plpgsql
security invoker
set search_path = public, private, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
  v_attempt public.review_attempts%rowtype;
  v_schedule public.schedule_states%rowtype;
  v_expected jsonb := payload->'expected_schedule';
  v_ability text;
begin
  if v_uid is null then raise exception 'mark_attempt_correct: 需要登入'; end if;
  if not (payload ? 'expected_schedule') or v_expected = 'null'::jsonb then
    raise exception 'sync_conflict:legacy_correction_requires_review';
  end if;
  select * into v_attempt from public.review_attempts
   where user_id=v_uid and session_id=payload->>'session_id' and exercise_id=payload->>'exercise_id';
  if not found then raise exception 'mark_attempt_correct: 找不到作答紀錄'; end if;
  v_ability := case when v_attempt.exercise_type='reading' then 'reading' else 'recall' end;
  perform pg_advisory_xact_lock(hashtextextended(v_uid::text || ':' || v_attempt.learning_item_id || ':' || v_ability, 0));
  select * into v_schedule from public.schedule_states
   where user_id=v_uid and learning_item_id=v_attempt.learning_item_id and ability=v_ability;

  -- 已完成的重送只接受伺服器已經等於本次目標；尚未完成才核對前置狀態。
  if v_attempt.result='correct' then
    if not found
      or v_schedule.due_at is distinct from (payload->'schedule'->>'due_at')::timestamptz
      or v_schedule.interval_days is distinct from (payload->'schedule'->>'interval_days')::integer
      or v_schedule.streak is distinct from (payload->'schedule'->>'streak')::integer
      or v_schedule.lapse_count is distinct from (payload->'schedule'->>'lapse_count')::integer
    then raise exception 'sync_conflict:mark_attempt_correct_retry'; end if;
  else
    if not found
      or v_schedule.due_at is distinct from (v_expected->>'due_at')::timestamptz
      or v_schedule.interval_days is distinct from (v_expected->>'interval_days')::integer
      or v_schedule.streak is distinct from (v_expected->>'streak')::integer
      or v_schedule.lapse_count is distinct from (v_expected->>'lapse_count')::integer
      or v_schedule.last_reviewed_at is distinct from (v_expected->>'last_reviewed_at')::timestamptz
    then raise exception 'sync_conflict:schedule_changed'; end if;
  end if;
  return private.mark_attempt_correct_legacy(payload);
end $$;

revoke all on function public.record_graded_attempt(jsonb) from public, anon;
revoke all on function public.mark_attempt_correct(jsonb) from public, anon;
grant execute on function public.record_graded_attempt(jsonb) to authenticated, service_role;
grant execute on function public.mark_attempt_correct(jsonb) to authenticated, service_role;
