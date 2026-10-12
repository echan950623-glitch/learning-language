-- Cascading Auth deletion must not recreate a revision for the removed owner.
create or replace function learning_internal.bump_learning_revision()
returns trigger language plpgsql security definer set search_path = '' as $$
declare owner_id uuid;
begin
  owner_id := case when TG_OP = 'DELETE' then OLD.user_id else NEW.user_id end;
  if TG_OP = 'DELETE' and not exists(select 1 from auth.users where id=owner_id) then
    return null;
  end if;
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
