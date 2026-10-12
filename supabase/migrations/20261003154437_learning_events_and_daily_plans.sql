-- Additive metadata: old attempts and schedules remain unchanged.
alter table public.learning_items add column learning_metadata jsonb not null default '{}'::jsonb;
alter table public.schedule_states add column learning_metadata jsonb not null default '{}'::jsonb;
alter table public.study_sessions add column learning_metadata jsonb not null default '{}'::jsonb;
alter table public.review_attempts add column learning_metadata jsonb;
alter table public.user_preferences drop constraint user_preferences_daily_new_item_cap_check;
alter table public.user_preferences add constraint user_preferences_daily_new_item_cap_check check (daily_new_item_cap >= 0 and daily_new_item_cap <= 50);
alter table public.user_preferences alter column daily_new_item_cap set default 5;

create table public.daily_learning_plans (
  user_id uuid not null references auth.users(id) on delete cascade,
  id text not null,
  plan jsonb not null,
  primary key(user_id,id)
);
alter table public.daily_learning_plans enable row level security;
create policy own_daily_plan on public.daily_learning_plans for select to authenticated using ((select auth.uid()) = user_id);
revoke all on public.daily_learning_plans from public, anon, authenticated;
grant select on public.daily_learning_plans to authenticated;
create trigger daily_plans_revision after insert or update or delete on public.daily_learning_plans
  for each row execute function learning_internal.bump_learning_revision();

create table learning_internal.learning_events (
  user_id uuid not null references auth.users(id) on delete cascade,
  id text not null,
  event_payload jsonb not null,
  primary key(user_id,id)
);
revoke all on learning_internal.learning_events from public, anon, authenticated;
grant usage on schema learning_internal to authenticated;

create function learning_internal.reserve_daily_plan(payload jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  owner_id uuid := auth.uid();
  today text := to_char(current_timestamp at time zone 'Asia/Taipei','YYYY-MM-DD');
  plan_id text := 'ja:' || today;
  saved jsonb;
  ids jsonb;
  cap integer;
begin
  if owner_id is null or coalesce(auth.jwt()->>'client_id','') <> '' then raise exception 'learning_write_forbidden'; end if;
  if payload->>'date' is distinct from today or payload->>'timeZone' is distinct from 'Asia/Taipei' then raise exception 'learning_day_changed'; end if;
  perform pg_advisory_xact_lock(hashtextextended(owner_id::text || ':' || plan_id,0));
  cap := least(coalesce((select daily_new_item_cap from public.user_preferences where user_id=owner_id),5), (payload->>'newItemCap')::integer);
  if cap is null or cap < 0 or cap > 50 then raise exception 'invalid_daily_cap'; end if;
  select plan into saved from public.daily_learning_plans where user_id=owner_id and id=plan_id for update;
  ids := coalesce(saved->'newItemIds','[]'::jsonb);
  if jsonb_array_length(ids) < cap and not coalesce((payload->>'busy')::boolean,false) then
    select ids || coalesce(jsonb_agg(candidate.id),'[]'::jsonb) into ids from (
      select i.id from public.learning_items i
      where i.user_id=owner_id and i.language='ja' and i.archived_at is null
        and not (ids ? i.id) and not (i.learning_metadata ? 'introducedAt')
        and not exists(select 1 from public.schedule_states s where s.user_id=owner_id and s.learning_item_id=i.id)
        and (payload->'newItemIds') ? i.id
      order by i.created_at,i.id limit greatest(0,cap-jsonb_array_length(ids))
    ) candidate;
  end if;
  saved := coalesce(saved,payload) || jsonb_build_object('id',plan_id,'date',today,'timeZone','Asia/Taipei','newItemIds',ids,'newItemCap',(payload->>'newItemCap')::integer);
  insert into public.daily_learning_plans(user_id,id,plan) values(owner_id,plan_id,saved)
    on conflict(user_id,id) do update set plan=excluded.plan;
  return saved;
end;
$$;
revoke all on function learning_internal.reserve_daily_plan(jsonb) from public,anon;
grant execute on function learning_internal.reserve_daily_plan(jsonb) to authenticated;
create function public.reserve_daily_plan(payload jsonb) returns jsonb language sql security invoker set search_path = ''
  as $$ select learning_internal.reserve_daily_plan(payload) $$;
revoke all on function public.reserve_daily_plan(jsonb) from public,anon;
grant execute on function public.reserve_daily_plan(jsonb) to authenticated;

-- The legacy guards keep their content/ownership checks. Metadata is added only
-- after those checks pass; an existing modern session cannot lose its metadata.
alter function public.upsert_study_session_guarded(jsonb) set schema learning_internal;
alter function learning_internal.upsert_study_session_guarded(jsonb) rename to upsert_study_session_v1;
create function public.upsert_study_session_guarded(payload jsonb) returns jsonb
language plpgsql security invoker set search_path = '' as $$
declare result jsonb; existing jsonb;
begin
  result := learning_internal.upsert_study_session_v1(payload);
  select learning_metadata into existing from public.study_sessions where id=payload->>'id' and user_id=auth.uid();
  if payload ? 'learning_metadata' then
    if existing <> '{}'::jsonb and existing <> payload->'learning_metadata' then raise exception 'sync_conflict:session_metadata_changed'; end if;
    update public.study_sessions set learning_metadata=payload->'learning_metadata' where id=payload->>'id' and user_id=auth.uid();
  end if;
  return result;
end;
$$;
revoke all on function public.upsert_study_session_guarded(jsonb) from public,anon;
grant execute on function public.upsert_study_session_guarded(jsonb) to authenticated;

alter function public.upsert_learning_item_guarded(jsonb) set schema learning_internal;
alter function learning_internal.upsert_learning_item_guarded(jsonb) rename to upsert_learning_item_v1;
create function public.upsert_learning_item_guarded(payload jsonb) returns jsonb
language plpgsql security invoker set search_path = '' as $$
declare result jsonb; existing jsonb;
begin
  result := learning_internal.upsert_learning_item_v1(payload);
  select learning_metadata into existing from public.learning_items where id=payload->>'id' and user_id=auth.uid();
  if payload ? 'learning_metadata' then
    if existing <> '{}'::jsonb and existing <> payload->'learning_metadata' then raise exception 'sync_conflict:item_metadata_changed'; end if;
    update public.learning_items set learning_metadata=payload->'learning_metadata' where id=payload->>'id' and user_id=auth.uid();
  end if;
  return result;
end;
$$;
revoke all on function public.upsert_learning_item_guarded(jsonb) from public,anon;
grant execute on function public.upsert_learning_item_guarded(jsonb) to authenticated;

alter function public.upsert_schedule_state_guarded(jsonb) set schema learning_internal;
alter function learning_internal.upsert_schedule_state_guarded(jsonb) rename to upsert_schedule_state_v1;
create function public.upsert_schedule_state_guarded(payload jsonb) returns jsonb
language plpgsql security invoker set search_path = '' as $$
declare result jsonb; existing jsonb;
begin
  result := learning_internal.upsert_schedule_state_v1(payload);
  select learning_metadata into existing from public.schedule_states where learning_item_id=payload->>'learning_item_id' and ability=payload->>'ability' and user_id=auth.uid();
  if payload ? 'learning_metadata' then
    if existing <> '{}'::jsonb and existing <> payload->'learning_metadata' then raise exception 'sync_conflict:schedule_metadata_changed'; end if;
    update public.schedule_states set learning_metadata=payload->'learning_metadata' where learning_item_id=payload->>'learning_item_id' and ability=payload->>'ability' and user_id=auth.uid();
  end if;
  return result;
end;
$$;
revoke all on function public.upsert_schedule_state_guarded(jsonb) from public,anon;
grant execute on function public.upsert_schedule_state_guarded(jsonb) to authenticated;

alter function public.upsert_review_attempt_guarded(jsonb) set schema learning_internal;
alter function learning_internal.upsert_review_attempt_guarded(jsonb) rename to upsert_review_attempt_v1;
create function public.upsert_review_attempt_guarded(payload jsonb) returns jsonb
language plpgsql security invoker set search_path = '' as $$
declare result jsonb; existing jsonb;
begin
  result := learning_internal.upsert_review_attempt_v1(payload);
  select learning_metadata into existing from public.review_attempts where id=payload->>'id' and user_id=auth.uid();
  if payload ? 'learning_metadata' then
    if existing is not null and existing <> payload->'learning_metadata' then raise exception 'sync_conflict:attempt_metadata_changed'; end if;
    update public.review_attempts set learning_metadata=payload->'learning_metadata' where id=payload->>'id' and user_id=auth.uid();
  end if;
  return result;
end;
$$;
revoke all on function public.upsert_review_attempt_guarded(jsonb) from public,anon;
grant execute on function public.upsert_review_attempt_guarded(jsonb) to authenticated;

create function learning_internal.commit_learning_event(payload jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  owner_id uuid := auth.uid();
  prior jsonb;
  before_session public.study_sessions%rowtype;
  current_session public.study_sessions%rowtype;
  after_session public.study_sessions%rowtype;
  answer public.review_attempts%rowtype;
  expected_schedule public.schedule_states%rowtype;
  current_schedule public.schedule_states%rowtype;
  after_schedule public.schedule_states%rowtype;
  question public.learning_items%rowtype;
  before_item public.learning_items%rowtype;
  current_item public.learning_items%rowtype;
  schedule_json jsonb;
  reserved_plan jsonb;
  kind text := payload->>'kind';
  position integer;
  unit jsonb;
  merged_completed jsonb;
  expected_units jsonb;
  retry_unit jsonb;
  replay_ids jsonb;
begin
  if owner_id is null or coalesce(auth.jwt()->>'client_id','') <> '' then raise exception 'learning_write_forbidden'; end if;
  if coalesce(payload->>'id','')='' or kind not in ('plan','introduction','hint','attempt','correction','edit') then raise exception 'invalid_learning_event'; end if;
  perform pg_advisory_xact_lock(hashtextextended(owner_id::text || ':learning',0));
  select e.event_payload into prior from learning_internal.learning_events e where e.user_id=owner_id and e.id=payload->>'id';
  if prior is not null then
    if prior <> payload then raise exception 'sync_conflict:event_payload_changed'; end if;
    return jsonb_build_object('applied',true,'replayed',true);
  end if;
  if payload ? 'plan' then
    select p.plan into reserved_plan from public.daily_learning_plans p where p.user_id=owner_id and p.id=payload->'plan'->>'id' for update;
    if reserved_plan is null or not ((reserved_plan->'newItemIds') @> (payload->'plan'->'newItemIds'))
      or reserved_plan->>'date' is distinct from payload->'plan'->>'date' or reserved_plan->>'timeZone' is distinct from payload->'plan'->>'timeZone'
      then raise exception 'daily_plan_not_reserved'; end if;
  end if;
  if kind='edit' then
    before_item := jsonb_populate_record(null::public.learning_items,payload->'beforeItem');
    question := jsonb_populate_record(null::public.learning_items,payload->'item');
    if before_item.user_id is distinct from owner_id or question.user_id is distinct from owner_id or question.id is distinct from before_item.id then raise exception 'sync_auth_mismatch'; end if;
    select * into current_item from public.learning_items where id=question.id and user_id=owner_id for update;
    if not found or current_item.archived_at is not null or current_item.prompt_zh is distinct from before_item.prompt_zh
      or current_item.answer is distinct from before_item.answer or current_item.reading is distinct from before_item.reading
      or current_item.learning_metadata is distinct from coalesce(before_item.learning_metadata,'{}'::jsonb)
      or current_item.explanation is distinct from before_item.explanation or current_item.example_sentence is distinct from before_item.example_sentence
      or current_item.part_of_speech is distinct from before_item.part_of_speech then raise exception 'sync_conflict:item_version_changed'; end if;
    if (question.learning_metadata->>'contentVersion')::integer <> coalesce((current_item.learning_metadata->>'contentVersion')::integer,1)+1 then raise exception 'invalid_item_version'; end if;
    if jsonb_array_length(payload->'beforeSchedules') <> (select count(*) from public.schedule_states where user_id=owner_id and learning_item_id=question.id)
      or jsonb_array_length(payload->'schedules') <> jsonb_array_length(payload->'beforeSchedules') then raise exception 'sync_conflict:schedule_changed'; end if;
    for schedule_json in select value from jsonb_array_elements(payload->'beforeSchedules') loop
      expected_schedule := jsonb_populate_record(null::public.schedule_states,schedule_json);
      select * into current_schedule from public.schedule_states where user_id=owner_id and learning_item_id=question.id and ability=expected_schedule.ability for update;
      if not found or expected_schedule.user_id is distinct from owner_id or expected_schedule.learning_item_id is distinct from question.id
        or current_schedule.due_at is distinct from expected_schedule.due_at or current_schedule.streak is distinct from expected_schedule.streak
        or current_schedule.lapse_count is distinct from expected_schedule.lapse_count or current_schedule.interval_days is distinct from expected_schedule.interval_days
        or current_schedule.last_reviewed_at is distinct from expected_schedule.last_reviewed_at
        or current_schedule.learning_metadata is distinct from coalesce(expected_schedule.learning_metadata,'{}'::jsonb) then raise exception 'sync_conflict:schedule_changed'; end if;
    end loop;
    for schedule_json in select value from jsonb_array_elements(payload->'schedules') loop
      after_schedule := jsonb_populate_record(null::public.schedule_states,schedule_json);
      if after_schedule.user_id is distinct from owner_id or after_schedule.learning_item_id is distinct from question.id then raise exception 'sync_auth_mismatch'; end if;
      update public.schedule_states set due_at=after_schedule.due_at,interval_days=after_schedule.interval_days,streak=after_schedule.streak,
        learning_metadata=coalesce(after_schedule.learning_metadata,'{}'::jsonb) where user_id=owner_id and learning_item_id=question.id and ability=after_schedule.ability;
      if not found then raise exception 'sync_conflict:schedule_changed'; end if;
    end loop;
    update public.learning_items set prompt_zh=question.prompt_zh,answer=question.answer,reading=question.reading,explanation=question.explanation,
      part_of_speech=question.part_of_speech,example_sentence=question.example_sentence,status=question.status,learning_metadata=question.learning_metadata
      where user_id=owner_id and id=question.id;
  elsif kind <> 'plan' then
    before_session := jsonb_populate_record(null::public.study_sessions,payload->'beforeSession');
    after_session := jsonb_populate_record(null::public.study_sessions,payload->'session');
    if before_session.user_id is distinct from owner_id or after_session.user_id is distinct from owner_id or before_session.id is distinct from after_session.id then raise exception 'sync_auth_mismatch'; end if;
    select * into current_session from public.study_sessions where id=before_session.id and user_id=owner_id for update;
    if not found or current_session.status is distinct from before_session.status or current_session.planned_units is distinct from before_session.planned_units
      or current_session.learning_metadata is distinct from before_session.learning_metadata or current_session.started_at is distinct from before_session.started_at
      then raise exception 'sync_conflict:learning_session_changed'; end if;
    if current_session.learning_metadata->>'ruleVersion' <> '2' or after_session.started_at is distinct from current_session.started_at
      or after_session.language is distinct from current_session.language then raise exception 'invalid_learning_session'; end if;
    if (after_session.learning_metadata - 'understoodItemIds' - 'hintedIndices') is distinct from (current_session.learning_metadata - 'understoodItemIds' - 'hintedIndices')
      or not ((after_session.learning_metadata->'understoodItemIds') @> (current_session.learning_metadata->'understoodItemIds'))
      or not ((after_session.learning_metadata->'hintedIndices') @> (current_session.learning_metadata->'hintedIndices')) then raise exception 'invalid_learning_metadata_change'; end if;
    select count(*) into position from public.review_attempts where user_id=owner_id and session_id=current_session.id;
    unit := current_session.planned_units->position;
    if kind in ('attempt','correction') then
      answer := jsonb_populate_record(null::public.review_attempts,payload->'attempt');
      if answer.user_id is distinct from owner_id or answer.session_id is distinct from current_session.id or answer.learning_metadata->>'ruleVersion' <> '2' then raise exception 'invalid_learning_answer'; end if;
      if kind='attempt' and (current_session.status <> 'in_progress' or answer.sequence_in_session <> position
        or unit->>'learningItemId' is distinct from answer.learning_item_id or unit->>'ability' is distinct from answer.exercise_type) then raise exception 'sync_conflict:learning_question_changed'; end if;
      if kind='attempt' and unit ? 'recallNotBefore' and answer.reviewed_at < (unit->>'recallNotBefore')::timestamptz then raise exception 'recall_gap_not_elapsed'; end if;
      if kind='attempt' and ((answer.learning_metadata->>'attemptNumber')::integer is distinct from coalesce((unit->>'attemptNumber')::integer,0)
        or (answer.learning_metadata->>'attemptNumber')::integer not between 0 and 2
        or ((current_session.learning_metadata->'hintedIndices') @> jsonb_build_array(position) and not answer.used_hint)) then raise exception 'invalid_learning_evidence'; end if;
      if payload ? 'replayAttemptIds' then
        select coalesce(jsonb_agg(id order by id),'[]'::jsonb) into replay_ids from public.review_attempts where user_id=owner_id and learning_item_id=answer.learning_item_id and exercise_type=answer.exercise_type;
        if replay_ids is distinct from payload->'replayAttemptIds' then raise exception 'sync_conflict:schedule_changed'; end if;
      end if;
      expected_units := current_session.planned_units;
      if kind='attempt' and (answer.result <> 'correct' or answer.used_hint) and coalesce((unit->>'attemptNumber')::integer,0)<2 and position+4<=jsonb_array_length(expected_units) then
        retry_unit := unit || jsonb_build_object('attemptNumber',coalesce((unit->>'attemptNumber')::integer,0)+1,'requiresIntroduction',false);
        expected_units := jsonb_insert(expected_units,array[(position+4)::text],retry_unit,false);
      elsif kind='correction' then
        select coalesce(jsonb_agg(value order by ordinality),'[]'::jsonb) into expected_units from jsonb_array_elements(expected_units) with ordinality
          where ordinality<=position or not (value->>'learningItemId'=answer.learning_item_id and value->>'ability'=answer.exercise_type and coalesce((value->>'attemptNumber')::integer,0)=(answer.learning_metadata->>'attemptNumber')::integer+1);
      end if;
      if after_session.planned_units is distinct from expected_units then raise exception 'invalid_reinforcement_queue'; end if;
      if (after_session.status='completed') is distinct from (jsonb_array_length(expected_units)=case when kind='attempt' then position+1 else position end)
        or (after_session.status='completed' and after_session.completed_at is distinct from answer.reviewed_at)
        or (after_session.status='in_progress' and after_session.completed_at is not null) then raise exception 'invalid_learning_completion'; end if;
      if kind='correction' and (answer.sequence_in_session <> position-1 or answer.result <> 'correct'
        or not exists(select 1 from public.review_attempts a where a.user_id=owner_id and a.id=answer.id and a.session_id=answer.session_id and a.exercise_id=answer.exercise_id)) then raise exception 'sync_conflict:correction_not_latest'; end if;
      perform pg_advisory_xact_lock(hashtextextended(owner_id::text || ':' || answer.learning_item_id || ':' || answer.exercise_type,0));
      select * into current_schedule from public.schedule_states where user_id=owner_id and learning_item_id=answer.learning_item_id and ability=answer.exercise_type for update;
      if payload->'beforeSchedule'='null'::jsonb then
        if found then raise exception 'sync_conflict:schedule_changed'; end if;
      else
        expected_schedule := jsonb_populate_record(null::public.schedule_states,payload->'beforeSchedule');
        if not found or expected_schedule.user_id is distinct from owner_id or current_schedule.due_at is distinct from expected_schedule.due_at
          or current_schedule.interval_days is distinct from expected_schedule.interval_days or current_schedule.streak is distinct from expected_schedule.streak
          or current_schedule.lapse_count is distinct from expected_schedule.lapse_count or current_schedule.last_reviewed_at is distinct from expected_schedule.last_reviewed_at
          or current_schedule.learning_metadata is distinct from coalesce(expected_schedule.learning_metadata,'{}'::jsonb) then raise exception 'sync_conflict:schedule_changed'; end if;
      end if;
      if payload->'schedule'<>'null'::jsonb then
        after_schedule := jsonb_populate_record(null::public.schedule_states,payload->'schedule');
        if after_schedule.user_id is distinct from owner_id or after_schedule.learning_item_id is distinct from answer.learning_item_id or after_schedule.ability is distinct from answer.exercise_type then raise exception 'sync_auth_mismatch'; end if;
        if kind='attempt' and (answer.learning_metadata->>'attemptNumber')::integer>0 and
          (after_schedule.due_at is distinct from current_schedule.due_at or after_schedule.interval_days is distinct from current_schedule.interval_days
           or after_schedule.streak is distinct from current_schedule.streak or after_schedule.lapse_count is distinct from current_schedule.lapse_count
           or coalesce(after_schedule.learning_metadata,'{}') is distinct from current_schedule.learning_metadata) then raise exception 'retry_cannot_advance_schedule'; end if;
        if kind='attempt' and not (payload ? 'replayAttemptIds') and answer.result='correct' and current_schedule.due_at > answer.reviewed_at and
          (after_schedule.due_at is distinct from current_schedule.due_at or after_schedule.interval_days is distinct from current_schedule.interval_days
           or after_schedule.streak is distinct from current_schedule.streak or after_schedule.lapse_count is distinct from current_schedule.lapse_count) then raise exception 'practice_cannot_advance_schedule'; end if;
        insert into public.schedule_states(user_id,learning_item_id,ability,language,due_at,interval_days,streak,lapse_count,last_reviewed_at,learning_metadata)
          values(owner_id,after_schedule.learning_item_id,after_schedule.ability,after_schedule.language,after_schedule.due_at,after_schedule.interval_days,after_schedule.streak,after_schedule.lapse_count,after_schedule.last_reviewed_at,coalesce(after_schedule.learning_metadata,'{}'))
          on conflict(learning_item_id,ability) do update set due_at=excluded.due_at,interval_days=excluded.interval_days,streak=excluded.streak,lapse_count=excluded.lapse_count,last_reviewed_at=excluded.last_reviewed_at,learning_metadata=excluded.learning_metadata;
      elsif current_schedule.learning_item_id is not null then raise exception 'cannot_remove_learning_schedule'; end if;
      if kind='attempt' then
        insert into public.review_attempts(id,user_id,session_id,sequence_in_session,exercise_id,learning_item_id,language,exercise_type,result,used_hint,response_time_ms,reviewed_at,learning_metadata)
          values(answer.id,owner_id,answer.session_id,answer.sequence_in_session,answer.exercise_id,answer.learning_item_id,answer.language,answer.exercise_type,answer.result,answer.used_hint,answer.response_time_ms,answer.reviewed_at,answer.learning_metadata);
      else
        update public.review_attempts set result=answer.result,learning_metadata=answer.learning_metadata where id=answer.id and user_id=owner_id;
      end if;
    elsif current_session.status <> 'in_progress' then raise exception 'invalid_learning_state_change';
    elsif kind='hint' and after_session.planned_units <> current_session.planned_units then raise exception 'invalid_learning_state_change';
    elsif kind='introduction' then
      if (select jsonb_agg(value - 'recallNotBefore' order by ordinality) from jsonb_array_elements(after_session.planned_units) with ordinality)
        is distinct from (select jsonb_agg(value - 'recallNotBefore' order by ordinality) from jsonb_array_elements(current_session.planned_units) with ordinality) then raise exception 'invalid_introduction_queue_change'; end if;
    end if;
    if payload ? 'item' then
      question := jsonb_populate_record(null::public.learning_items,payload->'item');
      if question.user_id is distinct from owner_id then raise exception 'sync_auth_mismatch'; end if;
      select * into current_item from public.learning_items where id=question.id and user_id=owner_id for update;
      if not found or coalesce((current_item.learning_metadata->>'contentVersion')::integer,1) is distinct from coalesce((question.learning_metadata->>'contentVersion')::integer,1) then raise exception 'sync_conflict:item_version_changed'; end if;
      if kind='introduction' then
        select p.plan into reserved_plan from public.daily_learning_plans p where p.user_id=owner_id and p.id=current_session.learning_metadata->>'dailyPlanId';
        if ((reserved_plan is null or not (reserved_plan->'newItemIds' ? question.id)) and not exists(select 1 from public.learning_items i where i.id=question.id and i.user_id=owner_id and i.learning_metadata->>'needsUnderstanding'='true' and
          (i.learning_metadata ? 'introducedAt' or exists(select 1 from public.schedule_states s where s.learning_item_id=i.id and s.user_id=owner_id))))
          or not exists(select 1 from jsonb_array_elements(current_session.planned_units) planned where planned->>'learningItemId'=question.id and planned->>'requiresIntroduction'='true') then raise exception 'daily_plan_not_reserved'; end if;
      end if;
      if kind='introduction' then
        question.learning_metadata := coalesce(question.learning_metadata,'{}'::jsonb) ||
          case when current_item.learning_metadata ? 'introducedAt' then jsonb_build_object('introducedAt',current_item.learning_metadata->>'introducedAt') else '{}'::jsonb end;
      end if;
      update public.learning_items set learning_metadata=coalesce(question.learning_metadata,'{}'::jsonb) where id=question.id and user_id=owner_id;
      if not found then raise exception 'learning_item_missing'; end if;
      update public.learning_items i set status=case
        when exists(select 1 from public.schedule_states s where s.user_id=owner_id and s.learning_item_id=i.id and coalesce((s.learning_metadata->>'recentFailures')::integer,0)>=3) then 'struggling'
        when (select count(*) from public.schedule_states s where s.user_id=owner_id and s.learning_item_id=i.id and s.learning_metadata->>'ruleVersion'='2' and coalesce((s.learning_metadata->>'evidenceStreak')::integer,0)>=5 and s.ability in ('recall','reading')) = case when i.reading is not null and btrim(i.reading)<>'' and i.reading<>i.answer then 2 else 1 end then 'mastered'
        when i.learning_metadata ? 'introducedAt' or exists(select 1 from public.schedule_states s where s.user_id=owner_id and s.learning_item_id=i.id) then 'learning'
        else 'new' end where i.user_id=owner_id and i.id=question.id;
    end if;
    update public.study_sessions set status=after_session.status,completed_at=after_session.completed_at,planned_units=after_session.planned_units,
      learning_metadata=after_session.learning_metadata where id=current_session.id and user_id=owner_id;
  end if;
  if payload ? 'plan' then
    select coalesce(jsonb_agg(distinct value),'[]'::jsonb) into merged_completed from jsonb_array_elements_text(coalesce(reserved_plan->'completedUnitKeys','[]'::jsonb) || coalesce(payload->'plan'->'completedUnitKeys','[]'::jsonb));
    update public.daily_learning_plans set plan=(payload->'plan') || jsonb_build_object('newItemIds',reserved_plan->'newItemIds','completedUnitKeys',merged_completed) where user_id=owner_id and id=payload->'plan'->>'id';
  end if;
  insert into learning_internal.learning_events(user_id,id,event_payload) values(owner_id,payload->>'id',payload);
  return jsonb_build_object('applied',true,'replayed',false);
end;
$$;
revoke all on function learning_internal.commit_learning_event(jsonb) from public,anon;
grant execute on function learning_internal.commit_learning_event(jsonb) to authenticated;
create function public.commit_learning_event(payload jsonb) returns jsonb language sql security invoker set search_path = ''
  as $$ select learning_internal.commit_learning_event(payload) $$;
revoke all on function public.commit_learning_event(jsonb) from public,anon;
grant execute on function public.commit_learning_event(jsonb) to authenticated;
