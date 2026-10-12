-- Session-only skip. Never updates items, schedules, answers, or daily completion.
create function learning_internal.skip_vocabulary_event(payload jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  owner_id uuid := auth.uid();
  current_session public.study_sessions%rowtype;
  before_session public.study_sessions%rowtype;
  after_session public.study_sessions%rowtype;
  prior jsonb;
  position integer;
  item_id text;
  expected_units jsonb;
  expected_metadata jsonb;
begin
  if owner_id is null or coalesce(auth.jwt()->>'client_id','') <> '' then raise exception 'learning_write_forbidden'; end if;
  if coalesce(payload->>'id','')='' or payload->>'kind' is distinct from 'skip' or
    payload ?| array['item','attempt','schedule','beforeSchedule','plan','beforeItem','schedules'] then raise exception 'invalid_skip_event'; end if;
  perform pg_advisory_xact_lock(hashtextextended(owner_id::text || ':learning',0));
  select event_payload into prior from learning_internal.learning_events where user_id=owner_id and id=payload->>'id';
  if prior is not null then
    if prior <> payload then raise exception 'sync_conflict:event_payload_changed'; end if;
    return jsonb_build_object('applied',true,'replayed',true);
  end if;
  before_session := jsonb_populate_record(null::public.study_sessions,payload->'beforeSession');
  after_session := jsonb_populate_record(null::public.study_sessions,payload->'session');
  if before_session.user_id is distinct from owner_id or after_session.user_id is distinct from owner_id or
    before_session.id is distinct from after_session.id then raise exception 'sync_auth_mismatch'; end if;
  select * into current_session from public.study_sessions where id=before_session.id and user_id=owner_id for update;
  if not found or current_session.status <> 'in_progress' or
    to_jsonb(current_session) - 'learning_metadata' - 'updated_at' is distinct from to_jsonb(before_session) - 'learning_metadata' - 'updated_at' or
    coalesce(current_session.learning_metadata,'{}') is distinct from coalesce(before_session.learning_metadata,'{}') then
    raise exception 'sync_conflict:learning_session_changed';
  end if;
  select count(*) into position from public.review_attempts where session_id=current_session.id and user_id=owner_id;
  item_id := current_session.planned_units->position->>'learningItemId';
  if item_id is null or not exists(select 1 from public.learning_items where id=item_id and user_id=owner_id and type='vocabulary' and not (coalesce(learning_metadata,'{}') ? 'practice')) then raise exception 'invalid_skip_vocabulary'; end if;
  select coalesce(jsonb_agg(value order by ordinality),'[]') into expected_units
    from jsonb_array_elements(current_session.planned_units) with ordinality
    where ordinality <= position or value->>'learningItemId' <> item_id;
  expected_metadata := coalesce(current_session.learning_metadata,'{}');
  if expected_metadata->>'ruleVersion'='2' then
    expected_metadata := expected_metadata || jsonb_build_object('hintedIndices',
    (select coalesce(jsonb_agg(value),'[]') from jsonb_array_elements(coalesce(current_session.learning_metadata->'hintedIndices','[]')) where (value::text)::integer < position));
  end if;
  if after_session.planned_units is distinct from expected_units or
    coalesce(after_session.learning_metadata,'{}') is distinct from expected_metadata or
    after_session.started_at is distinct from current_session.started_at or
    after_session.language is distinct from current_session.language or
    after_session.new_item_ids is distinct from current_session.new_item_ids or
    after_session.review_item_ids is distinct from current_session.review_item_ids or
    (after_session.status='completed') is distinct from (jsonb_array_length(expected_units)=position) or
    after_session.status not in ('completed','in_progress') or
    (after_session.status='completed' and after_session.completed_at is null) or
    (after_session.status='in_progress' and after_session.completed_at is not null) then raise exception 'invalid_skip_state'; end if;
  update public.study_sessions set planned_units=expected_units,learning_metadata=expected_metadata,
    status=after_session.status,completed_at=after_session.completed_at where id=current_session.id and user_id=owner_id;
  insert into learning_internal.learning_events(user_id,id,event_payload) values(owner_id,payload->>'id',payload);
  return jsonb_build_object('applied',true,'replayed',false);
end;
$$;
revoke all on function learning_internal.skip_vocabulary_event(jsonb) from public,anon;
grant execute on function learning_internal.skip_vocabulary_event(jsonb) to authenticated;
create or replace function public.commit_learning_event(payload jsonb) returns jsonb
language plpgsql security invoker set search_path = '' as $$
begin
  if payload->>'kind'='skip' then return learning_internal.skip_vocabulary_event(payload); end if;
  return learning_internal.commit_learning_event(payload);
end;
$$;
revoke all on function public.commit_learning_event(jsonb) from public,anon;
grant execute on function public.commit_learning_event(jsonb) to authenticated;
