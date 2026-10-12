-- Local migration proposal. Does not change historical learning records.
create schema if not exists learning_internal;
revoke all on schema learning_internal from public, anon, authenticated;

create table public.learning_data_revisions (
  user_id uuid primary key references auth.users(id) on delete cascade,
  revision bigint not null default 0 check (revision >= 0)
);
alter table public.learning_data_revisions enable row level security;
revoke all on public.learning_data_revisions from public, anon, authenticated;
grant select on public.learning_data_revisions to authenticated;
create policy own_revision on public.learning_data_revisions for select to authenticated
  using ((select auth.uid()) = user_id);

-- Clients cannot edit or reset revisions. Only table triggers increment them,
-- in the same transaction as the learning-data change.
create function learning_internal.bump_learning_revision()
returns trigger language plpgsql security definer set search_path = '' as $$
declare owner_id uuid;
begin
  owner_id := case when TG_OP = 'DELETE' then OLD.user_id else NEW.user_id end;
  if auth.uid() is not null and owner_id is distinct from auth.uid() then
    raise exception 'sync_auth_mismatch';
  end if;
  if TG_OP = 'UPDATE' and OLD.user_id is distinct from NEW.user_id then
    raise exception 'learning_owner_is_immutable';
  end if;
  insert into public.learning_data_revisions(user_id, revision) values (owner_id, 1)
    on conflict(user_id) do update set revision = public.learning_data_revisions.revision + 1;
  return null;
end;
$$;
revoke all on function learning_internal.bump_learning_revision() from public, anon, authenticated;

create trigger learning_items_revision after insert or update or delete on public.learning_items
  for each row execute function learning_internal.bump_learning_revision();
create trigger schedule_states_revision after insert or update or delete on public.schedule_states
  for each row execute function learning_internal.bump_learning_revision();
create trigger study_sessions_revision after insert or update or delete on public.study_sessions
  for each row execute function learning_internal.bump_learning_revision();
create trigger review_attempts_revision after insert or update or delete on public.review_attempts
  for each row execute function learning_internal.bump_learning_revision();
create trigger user_preferences_revision after insert or update or delete on public.user_preferences
  for each row execute function learning_internal.bump_learning_revision();

create function public.get_learning_revision()
returns text language plpgsql stable security invoker set search_path = '' as $$
begin
  if auth.uid() is null then raise exception 'authentication_required'; end if;
  return coalesce((select revision::text from public.learning_data_revisions where user_id = auth.uid()), '0');
end;
$$;
revoke all on function public.get_learning_revision() from public, anon;
grant execute on function public.get_learning_revision() to authenticated;
