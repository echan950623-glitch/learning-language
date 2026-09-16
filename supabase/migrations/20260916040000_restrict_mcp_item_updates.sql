-- MCP clients may add new vocabulary, but must never modify an existing item.
-- The original policy allowed every authenticated OAuth client to UPDATE its
-- own learning_items rows. Tighten UPDATE to first-party app sessions only;
-- MCP's add_vocabulary_batch uses INSERT ... ON CONFLICT DO NOTHING, so it
-- does not need UPDATE permission.

drop policy if exists learning_items_update_own on public.learning_items;
drop policy if exists learning_items_update_own_app_only on public.learning_items;

create policy learning_items_update_own_app_only
  on public.learning_items
  for update
  to authenticated
  using (auth.uid() = user_id and (auth.jwt() ->> 'client_id') is null)
  with check (auth.uid() = user_id and (auth.jwt() ->> 'client_id') is null);
