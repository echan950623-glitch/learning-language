-- user_preferences 是單一份可變設定，不是作答歷史。舊版 guarded RPC 在已有列且值不同時
-- 永遠丟 sync_conflict，導致每次點選題數／新字上限都在 FIFO outbox 多卡一筆。
-- 保留 auth.uid() ownership guard 與 RLS/security invoker；同一使用者的後續設定依 outbox
-- 順序更新，最後一筆就是目前選擇。資料表 check constraints 仍限制合法值。
create or replace function public.upsert_preferences_guarded(payload jsonb)
returns jsonb
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
  v_result public.user_preferences%rowtype;
begin
  if v_uid is null or payload->>'user_id' is distinct from v_uid::text then
    raise exception 'sync_auth_mismatch';
  end if;

  insert into public.user_preferences(user_id, daily_question_count, daily_new_item_cap)
  values(
    v_uid,
    (payload->>'daily_question_count')::integer,
    (payload->>'daily_new_item_cap')::integer
  )
  on conflict (user_id) do update
  set daily_question_count = excluded.daily_question_count,
      daily_new_item_cap = excluded.daily_new_item_cap,
      updated_at = now()
  returning * into v_result;

  return to_jsonb(v_result);
end
$$;

revoke all on function public.upsert_preferences_guarded(jsonb) from public, anon;
grant execute on function public.upsert_preferences_guarded(jsonb) to authenticated;
