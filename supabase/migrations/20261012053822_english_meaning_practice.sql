-- Additive English recognition support. Existing Japanese rows and evidence are untouched.
alter table public.schedule_states drop constraint schedule_states_ability_check;
alter table public.schedule_states add constraint schedule_states_ability_check check (ability in ('recall','reading','meaning'));
alter table public.review_attempts drop constraint review_attempts_exercise_type_check;
alter table public.review_attempts add constraint review_attempts_exercise_type_check check (exercise_type in ('recall','reading','meaning','spelling','translation'));

create function learning_internal.english_text_key(t text) returns text
language sql immutable security invoker set search_path = '' as $$
  select lower(btrim(regexp_replace(normalize(coalesce(t,''),NFKC),'[[:space:]]+',' ','g')));
$$;
revoke all on function learning_internal.english_text_key(text) from public,anon;
grant execute on function learning_internal.english_text_key(text) to authenticated;
create function learning_internal.english_question_key(v jsonb) returns text
language sql immutable security invoker set search_path = '' as $$
  select jsonb_build_array(v->>'mode',learning_internal.english_text_key(v->>'sentence'),learning_internal.english_text_key(v->>'targetText'),
    (select jsonb_agg(learning_internal.english_text_key(c->>'text') order by learning_internal.english_text_key(c->>'text')) from jsonb_array_elements(v->'choices') as options(c)),
    (select learning_internal.english_text_key(c->>'text') from jsonb_array_elements(v->'choices') as options(c) where c->>'id'=v->>'correctChoiceId'))::text;
$$;
revoke all on function learning_internal.english_question_key(jsonb) from public,anon;
grant execute on function learning_internal.english_question_key(jsonb) to authenticated;

create function learning_internal.valid_english_content(p jsonb) returns boolean
language plpgsql immutable security invoker set search_path = '' as $$
declare v jsonb; c jsonb; direct_found boolean := false; context_found boolean := false; reserved_found boolean := false;
begin
  if p->'version' is distinct from '1'::jsonb or jsonb_typeof(p->'senseKey') is distinct from 'string' or coalesce(btrim(p->>'senseKey'),'')='' or length(p->>'senseKey')>160 or jsonb_typeof(p->'variants') is distinct from 'array' then return false; end if;
  if exists(select 1 from jsonb_object_keys(p) as k(key) where k.key not in ('version','senseKey','variants','activeVariantId')) then return false; end if;
  if jsonb_array_length(p->'variants') not between 3 and 30 then return false; end if;
  if (select count(distinct value->>'id') from jsonb_array_elements(p->'variants')) <> jsonb_array_length(p->'variants') then return false; end if;
  for v in select value from jsonb_array_elements(p->'variants') loop
    if jsonb_typeof(v) is distinct from 'object' or jsonb_typeof(v->'id') is distinct from 'string' or jsonb_typeof(v->'targetText') is distinct from 'string' or jsonb_typeof(v->'explanationZh') is distinct from 'string' or length(v->>'id')>160 or length(v->>'targetText')>160 or length(v->>'explanationZh')>2000 then return false; end if;
    if exists(select 1 from jsonb_object_keys(v) as k(key) where k.key not in ('id','mode','sentence','targetText','translationZh','choices','correctChoiceId','explanationZh','hint','role')) then return false; end if;
    if v ? 'hint' and (jsonb_typeof(v->'hint') is distinct from 'string' or btrim(v->>'hint')='' or length(v->>'hint')>2000) then return false; end if;
    if coalesce(btrim(v->>'id'),'')='' or coalesce(v->>'mode','') not in ('direct','context') or coalesce(v->>'role','') not in ('practice','verification') or coalesce(btrim(v->>'targetText'),'')='' or coalesce(btrim(v->>'explanationZh'),'')='' or jsonb_typeof(v->'choices') is distinct from 'array' then return false; end if;
    if jsonb_array_length(v->'choices')<>4 or (select count(distinct value->>'id') from jsonb_array_elements(v->'choices'))<>4 or (select count(distinct btrim(value->>'text')) from jsonb_array_elements(v->'choices'))<>4 then return false; end if;
    for c in select value from jsonb_array_elements(v->'choices') loop
      if jsonb_typeof(c) is distinct from 'object' or jsonb_typeof(c->'id') is distinct from 'string' or jsonb_typeof(c->'text') is distinct from 'string' or length(c->>'id')>80 or length(c->>'text')>160 or exists(select 1 from jsonb_object_keys(c) as k(key) where k.key not in ('id','text')) then return false; end if;
      if coalesce(btrim(c->>'id'),'')='' or coalesce(btrim(c->>'text'),'')='' then return false; end if;
    end loop;
    if not exists(select 1 from jsonb_array_elements(v->'choices') as options(choice) where options.choice->>'id'=v->>'correctChoiceId') then return false; end if;
    if v->>'mode'='direct' then
      if v ? 'sentence' or v ? 'translationZh' or v->>'role'<>'practice' then return false; end if;
      direct_found := true;
    else
      if jsonb_typeof(v->'sentence') is distinct from 'string' or jsonb_typeof(v->'translationZh') is distinct from 'string' or length(v->>'sentence')>2000 or length(v->>'translationZh')>2000 then return false; end if;
      if coalesce(btrim(v->>'sentence'),'')='' or coalesce(btrim(v->>'translationZh'),'')='' or position(lower(v->>'targetText') in lower(v->>'sentence'))=0 then return false; end if;
      context_found := context_found or v->>'role'='practice';
      reserved_found := reserved_found or v->>'role'='verification';
    end if;
  end loop;
  if (select count(distinct learning_internal.english_question_key(value)) from jsonb_array_elements(p->'variants')) <> jsonb_array_length(p->'variants') then return false; end if;
  return direct_found and context_found and reserved_found and (not (p ? 'activeVariantId') or exists(select 1 from jsonb_array_elements(p->'variants') as questions(variant) where questions.variant->>'id'=p->>'activeVariantId'));
exception when others then return false;
end;
$$;

-- Initial snapshot imports must supply classified metadata at INSERT time, before triggers run.
do $$
declare definition text; changed text;
begin
  select pg_get_functiondef('learning_internal.upsert_schedule_state_v1(jsonb)'::regprocedure) into definition;
  changed := replace(definition, 'streak,lapse_count,last_reviewed_at)', 'streak,lapse_count,last_reviewed_at,learning_metadata)');
  changed := replace(changed, $find$(payload->>'last_reviewed_at')::timestamptz) returning$find$, $replacement$(payload->>'last_reviewed_at')::timestamptz,coalesce(payload->'learning_metadata','{}'::jsonb)) returning$replacement$);
  if changed=definition then raise exception 'schedule_import_definition_changed'; end if;
  execute changed;
  select pg_get_functiondef('learning_internal.upsert_review_attempt_v1(jsonb)'::regprocedure) into definition;
  changed := replace(definition, 'response_time_ms,reviewed_at)', 'response_time_ms,reviewed_at,learning_metadata)');
  changed := replace(changed, $find$(payload->>'reviewed_at')::timestamptz)$find$, $replacement$(payload->>'reviewed_at')::timestamptz,payload->'learning_metadata')$replacement$);
  if changed=definition then raise exception 'attempt_import_definition_changed'; end if;
  execute changed;
end;
$$;
revoke all on function learning_internal.valid_english_content(jsonb) from public,anon;
grant execute on function learning_internal.valid_english_content(jsonb) to authenticated;

create function learning_internal.validate_english_item() returns trigger
language plpgsql security invoker set search_path = '' as $$
begin
  if new.learning_metadata ? 'englishPractice' and (new.language<>'en' or new.type not in ('vocabulary','phrase','collocation') or coalesce(btrim(new.part_of_speech),'')='' or new.learning_metadata ? 'practice' or new.learning_metadata ? 'coachReport' or not learning_internal.valid_english_content(new.learning_metadata->'englishPractice') or new.learning_metadata->'englishPractice' ? 'activeVariantId') then raise exception 'invalid_english_content'; end if;
  if new.learning_metadata ? 'englishPractice' and exists(select 1 from jsonb_array_elements(new.learning_metadata->'englishPractice'->'variants') as questions(v) where questions.v->>'mode'='direct' and btrim(questions.v->>'targetText') is distinct from btrim(new.answer)) then raise exception 'english_target_mismatch'; end if;
  return new;
end;
$$;
revoke all on function learning_internal.validate_english_item() from public,anon,authenticated;
create trigger validate_english_item before insert or update on public.learning_items for each row execute function learning_internal.validate_english_item();

create function learning_internal.validate_english_session() returns trigger
language plpgsql security invoker set search_path = '' as $$
declare u jsonb; i public.learning_items%rowtype;
begin
  for u in select value from jsonb_array_elements(new.planned_units) loop
    select * into i from public.learning_items where id=u->>'learningItemId' and user_id=new.user_id;
    -- Old historical sessions may refer to tombstones/missing items; only validate English snapshots/meaning units here.
    if u->>'ability'='meaning' or u->'itemSnapshot' ? 'englishPractice' then
      if not found or i.language<>'en' or new.language<>'en' or u->>'ability'<>'meaning' or u->'itemSnapshot'->>'language' is distinct from new.language or u->'itemSnapshot'->>'id' is distinct from i.id or not learning_internal.valid_english_content(u->'itemSnapshot'->'englishPractice') or not (u->'itemSnapshot'->'englishPractice' ? 'activeVariantId') then raise exception 'invalid_english_session'; end if;
      if tg_op='INSERT' and ((u->>'itemVersion')::integer is distinct from coalesce((i.learning_metadata->>'contentVersion')::integer,1) or ((u->'itemSnapshot'->'englishPractice') - 'activeVariantId') is distinct from i.learning_metadata->'englishPractice' or u->'itemSnapshot'->>'answer' is distinct from i.answer or u->'itemSnapshot'->>'promptZh' is distinct from i.prompt_zh) then raise exception 'english_snapshot_content_mismatch'; end if;
    end if;
  end loop;
  return new;
end;
$$;
revoke all on function learning_internal.validate_english_session() from public,anon,authenticated;
create trigger validate_english_session before insert or update on public.study_sessions for each row execute function learning_internal.validate_english_session();

create function learning_internal.validate_english_evidence() returns trigger
language plpgsql security invoker set search_path = '' as $$
declare i public.learning_items%rowtype; q jsonb; u jsonb; v jsonb; expected text; selected text; claimed text;
begin
  select * into i from public.learning_items where id=new.learning_item_id and user_id=new.user_id;
  if not found then raise exception 'learning_item_owner_mismatch'; end if;
  if coalesce(to_jsonb(new)->>'ability',to_jsonb(new)->>'exercise_type')='meaning' or i.learning_metadata ? 'englishPractice' then
    if i.language<>'en' or new.language<>'en' or not (i.learning_metadata ? 'englishPractice') or new.learning_metadata->>'ruleVersion' is distinct from '2' then raise exception 'english_requires_classified_evidence'; end if;
    if tg_table_name='schedule_states' then
      if new.ability<>'meaning' then raise exception 'english_ability_mismatch'; end if;
    else
      if new.exercise_type<>'meaning' then raise exception 'english_ability_mismatch'; end if;
      q := new.learning_metadata->'question';
      select planned_units->new.sequence_in_session into u from public.study_sessions where id=new.session_id and user_id=new.user_id and language='en';
      if u->>'ability' is distinct from 'meaning' or q is distinct from u->'itemSnapshot' or not learning_internal.valid_english_content(q->'englishPractice') then raise exception 'english_question_mismatch'; end if;
      select value into v from jsonb_array_elements(q->'englishPractice'->'variants') where value->>'id'=q->'englishPractice'->>'activeVariantId';
      select value->>'text' into expected from jsonb_array_elements(v->'choices') where value->>'id'=v->>'correctChoiceId';
      selected := new.learning_metadata->>'rawAnswer';
      claimed := new.learning_metadata->>'originalResult';
      if expected is null or selected is null or claimed is distinct from (case when selected=expected then 'correct' else 'incorrect' end) or new.result is distinct from claimed then raise exception 'english_answer_mismatch'; end if;
      if tg_op='UPDATE' and old.learning_metadata->'question' is distinct from q then raise exception 'english_question_changed'; end if;
    end if;
  end if;
  return new;
end;
$$;
revoke all on function learning_internal.validate_english_evidence() from public,anon,authenticated;
create trigger validate_english_attempt before insert or update on public.review_attempts for each row execute function learning_internal.validate_english_evidence();
create trigger validate_english_schedule before insert or update on public.schedule_states for each row execute function learning_internal.validate_english_evidence();

create or replace function learning_internal.reserve_daily_plan(payload jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare owner_id uuid := auth.uid(); today text := to_char(current_timestamp at time zone 'Asia/Taipei','YYYY-MM-DD');
  lang text := payload->>'language'; plan_id text; saved jsonb; ids jsonb; cap integer; u jsonb;
begin
  if owner_id is null or coalesce(auth.jwt()->>'client_id','')<>'' then raise exception 'learning_write_forbidden'; end if;
  if coalesce(lang,'') not in ('ja','en') then raise exception 'invalid_plan_language'; end if;
  plan_id := lang || ':' || today;
  if payload->>'id' is distinct from plan_id or payload->>'date' is distinct from today or payload->>'timeZone' is distinct from 'Asia/Taipei' then raise exception 'learning_day_changed'; end if;
  for u in select value from jsonb_array_elements(payload->'units') loop
    if not exists(select 1 from public.learning_items where id=u->>'learningItemId' and user_id=owner_id and language=lang) then raise exception 'plan_item_language_mismatch'; end if;
  end loop;
  perform pg_advisory_xact_lock(hashtextextended(owner_id::text || ':' || plan_id,0));
  cap := least(coalesce((select daily_new_item_cap from public.user_preferences where user_id=owner_id),5),(payload->>'newItemCap')::integer);
  if cap is null or cap<0 or cap>50 then raise exception 'invalid_daily_cap'; end if;
  select plan into saved from public.daily_learning_plans where user_id=owner_id and id=plan_id for update;
  if lang='en' and saved is not null then return saved; end if;
  ids := coalesce(saved->'newItemIds','[]'::jsonb);
  if jsonb_array_length(ids)<cap and not coalesce((payload->>'busy')::boolean,false) then
    select ids || coalesce(jsonb_agg(candidate.id),'[]'::jsonb) into ids from (
      select i.id from public.learning_items i where i.user_id=owner_id and i.language=lang and i.archived_at is null
        and not (ids ? i.id) and not (i.learning_metadata ? 'introducedAt')
        and (lang='ja' or i.learning_metadata ? 'englishPractice')
        and not exists(select 1 from public.schedule_states s where s.user_id=owner_id and s.learning_item_id=i.id)
        and (payload->'newItemIds') ? i.id order by i.created_at,i.id limit greatest(0,cap-jsonb_array_length(ids))
    ) candidate;
  end if;
  saved := coalesce(saved,payload) || jsonb_build_object('id',plan_id,'date',today,'language',lang,'timeZone','Asia/Taipei','newItemIds',ids,'newItemCap',(payload->>'newItemCap')::integer);
  insert into public.daily_learning_plans(user_id,id,plan) values(owner_id,plan_id,saved) on conflict(user_id,id) do update set plan=excluded.plan;
  return saved;
end;
$$;
-- Existing function ACL and restricted public wrapper remain intact.

-- Preserve the existing atomic replay/ownership/sequence guards behind a language-aware boundary.
alter function learning_internal.commit_learning_event(jsonb) rename to commit_learning_event_before_english;
revoke all on function learning_internal.commit_learning_event_before_english(jsonb) from public,anon,authenticated;
create function learning_internal.commit_learning_event(payload jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare owner_id uuid := auth.uid(); p jsonb := payload->'plan'; s jsonb := payload->'session'; u jsonb;
begin
  if owner_id is null or coalesce(auth.jwt()->>'client_id','')<>'' then raise exception 'learning_write_forbidden'; end if;
  if p is not null then
    if coalesce(p->>'language','') not in ('ja','en') or p->>'id' is distinct from (p->>'language') || ':' || (p->>'date') then raise exception 'invalid_plan_language'; end if;
    if s is not null and (s->>'language' is distinct from p->>'language' or s->'learning_metadata'->>'dailyPlanId' is distinct from p->>'id') then raise exception 'session_plan_language_mismatch'; end if;
    for u in select value from jsonb_array_elements(p->'units') loop
      if not exists(select 1 from public.learning_items where id=u->>'learningItemId' and user_id=owner_id and language=p->>'language') then raise exception 'plan_item_language_mismatch'; end if;
    end loop;
  end if;
  return learning_internal.commit_learning_event_before_english(payload);
end;
$$;
revoke all on function learning_internal.commit_learning_event(jsonb) from public,anon;
grant execute on function learning_internal.commit_learning_event(jsonb) to authenticated;

-- Allow the existing session-only skip for English phrases as well as single words.
do $$
declare definition text;
begin
  select pg_get_functiondef('learning_internal.skip_vocabulary_event(jsonb)'::regprocedure) into definition;
  definition := replace(definition, $find$type='vocabulary' and not$find$, $replacement$(type='vocabulary' or learning_metadata ? 'englishPractice') and not$replacement$);
  execute definition;
end;
$$;
