-- Protect new semantic records when a still-open older PWA ignores their metadata.
-- Never rewrite existing items, attempts, schedules, or ownership.
create function learning_internal.validate_practice_evidence() returns trigger
language plpgsql security invoker set search_path = '' as $$
declare item_metadata jsonb;
begin
  select learning_metadata into item_metadata from public.learning_items
    where id = new.learning_item_id and user_id = new.user_id;
  if not found then raise exception 'learning_item_owner_mismatch'; end if;
  if item_metadata ? 'coachReport' then
    raise exception 'coach_observation_cannot_be_scored';
  end if;
  if item_metadata ? 'practice' then
    if new.learning_metadata->>'ruleVersion' is distinct from '2' then
      raise exception 'practice_requires_classified_evidence_update_app';
    end if;
    if tg_table_name = 'review_attempts' and new.learning_metadata->'question'->'practice'->>'version' is distinct from '1' then
      raise exception 'practice_requires_question_snapshot_update_app';
    end if;
  end if;
  return new;
end;
$$;
revoke all on function learning_internal.validate_practice_evidence() from public, anon, authenticated;
create trigger validate_practice_attempt before insert or update on public.review_attempts
  for each row execute function learning_internal.validate_practice_evidence();
create trigger validate_practice_schedule before insert or update on public.schedule_states
  for each row execute function learning_internal.validate_practice_evidence();
