-- Local proposal only. Apply and verify RLS on a separately authorized environment.
alter table public.learning_items add column if not exists archived_at timestamptz;

create or replace function public.archive_learning_items_guarded(payload jsonb)
returns void language plpgsql security invoker set search_path = '' as $$
declare requested_id text; stamp timestamptz;
begin
  if auth.uid() is null then raise exception 'authentication_required'; end if;
  if auth.jwt()->>'client_id' is not null then raise exception 'mcp_write_forbidden'; end if;
  if jsonb_typeof(payload->'ids') is distinct from 'array' then raise exception 'invalid_archive_ids'; end if;
  stamp := coalesce((payload->>'archivedAt')::timestamptz, now());
  for requested_id in select jsonb_array_elements_text(payload->'ids') loop
    update public.learning_items
      set archived_at = coalesce(archived_at, stamp)
      where id = requested_id and user_id = auth.uid();
    -- A missing row is idempotent; foreign-owner rows remain invisible under RLS.
  end loop;
end;
$$;
revoke all on function public.archive_learning_items_guarded(jsonb) from public, anon;
grant execute on function public.archive_learning_items_guarded(jsonb) to authenticated;

-- Retained legacy outbox entries and older clients get the same safe semantics.
create or replace function public.delete_learning_items_guarded(payload jsonb)
returns integer language plpgsql security invoker set search_path = '' as $$
begin
  perform public.archive_learning_items_guarded(payload);
  return jsonb_array_length(payload->'ids');
end;
$$;
revoke all on function public.delete_learning_items_guarded(jsonb) from public, anon;
grant execute on function public.delete_learning_items_guarded(jsonb) to authenticated;
