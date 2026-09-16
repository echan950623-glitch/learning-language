-- 雲端化架構（2026-09-16）：RLS 政策
--
-- 對應 ARCHITECTURE.md 該章節的「RLS 政策」小節。`(auth.jwt() ->> 'client_id') is null`
-- 代表「只有 App 自己的一般登入 session，不是 MCP／OAuth client 拿到的 token」——
-- 這是唯一的 MCP 權限窄化依據（見 Supabase 官方 OAuth Server 文件的 client_id claim）。
-- 這是真正的安全需求，不是裝飾：MCP 的四個工具全部透過使用者自己的 OAuth access token
-- 呼叫一般 Supabase client（見該章節「MCP」小節），RLS 是唯一擋下「MCP 幫使用者刪字／
-- 改歷史／碰 session」的機制。
--
-- 每個 UPDATE 政策都同時寫 USING 與 WITH CHECK（否則能把一列的 user_id 改成別人的）；
-- INSERT 只需要 WITH CHECK；SELECT／DELETE 只需要 USING。全部 `to authenticated`。

-- ---------------------------------------------------------------------------
-- learning_items
-- ---------------------------------------------------------------------------

-- SELECT：MCP 可讀，供 inventory／context 使用，不受 client_id 限制。
create policy learning_items_select_own
  on public.learning_items
  for select
  to authenticated
  using (auth.uid() = user_id);

-- INSERT：MCP 與 App 都可以——MCP 的 add_vocabulary_batch 需要這個權限。
create policy learning_items_insert_own
  on public.learning_items
  for insert
  to authenticated
  with check (auth.uid() = user_id);

-- UPDATE：只允許第一方 App。MCP 可以新增新字，但不能修改任何既有單字。
create policy learning_items_update_own_app_only
  on public.learning_items
  for update
  to authenticated
  using (auth.uid() = user_id and (auth.jwt() ->> 'client_id') is null)
  with check (auth.uid() = user_id and (auth.jwt() ->> 'client_id') is null);

-- DELETE：只有 App 自己能刪字，MCP 永遠不能刪——對應 PRODUCT 的「不可刪除單字」。
create policy learning_items_delete_own_app_only
  on public.learning_items
  for delete
  to authenticated
  using (auth.uid() = user_id and (auth.jwt() ->> 'client_id') is null);

-- ---------------------------------------------------------------------------
-- schedule_states（沒有 DELETE 政策：沒有人需要直接刪，靠 learning_items 的
-- on delete cascade 自然清除）
-- ---------------------------------------------------------------------------

create policy schedule_states_select_own
  on public.schedule_states
  for select
  to authenticated
  using (auth.uid() = user_id);

-- 只有 App 走 RPC 寫（record_graded_attempt／mark_attempt_correct 內部的 upsert）。
create policy schedule_states_insert_own_app_only
  on public.schedule_states
  for insert
  to authenticated
  with check (auth.uid() = user_id and (auth.jwt() ->> 'client_id') is null);

create policy schedule_states_update_own_app_only
  on public.schedule_states
  for update
  to authenticated
  using (auth.uid() = user_id and (auth.jwt() ->> 'client_id') is null)
  with check (auth.uid() = user_id and (auth.jwt() ->> 'client_id') is null);

-- ---------------------------------------------------------------------------
-- review_attempts（沒有 DELETE 政策）
-- ---------------------------------------------------------------------------

-- SELECT：MCP 讀取用於 get_learning_context 的正確率／提示率／錯題統計。
create policy review_attempts_select_own
  on public.review_attempts
  for select
  to authenticated
  using (auth.uid() = user_id);

-- INSERT／UPDATE：只有 App 的 RPC 寫，MCP 永遠不能寫入或改動歷史作答——
-- 對應 PRODUCT 的「不可改歷史 attempt」。
create policy review_attempts_insert_own_app_only
  on public.review_attempts
  for insert
  to authenticated
  with check (auth.uid() = user_id and (auth.jwt() ->> 'client_id') is null);

create policy review_attempts_update_own_app_only
  on public.review_attempts
  for update
  to authenticated
  using (auth.uid() = user_id and (auth.jwt() ->> 'client_id') is null)
  with check (auth.uid() = user_id and (auth.jwt() ->> 'client_id') is null);

-- ---------------------------------------------------------------------------
-- study_sessions（MCP 完全不能碰這張表：4 個工具都用不到 session 明細）
-- ---------------------------------------------------------------------------

create policy study_sessions_select_own_app_only
  on public.study_sessions
  for select
  to authenticated
  using (auth.uid() = user_id and (auth.jwt() ->> 'client_id') is null);

create policy study_sessions_insert_own_app_only
  on public.study_sessions
  for insert
  to authenticated
  with check (auth.uid() = user_id and (auth.jwt() ->> 'client_id') is null);

create policy study_sessions_update_own_app_only
  on public.study_sessions
  for update
  to authenticated
  using (auth.uid() = user_id and (auth.jwt() ->> 'client_id') is null)
  with check (auth.uid() = user_id and (auth.jwt() ->> 'client_id') is null);

-- ---------------------------------------------------------------------------
-- user_preferences（同樣 MCP 完全不能碰）
-- ---------------------------------------------------------------------------

create policy user_preferences_select_own_app_only
  on public.user_preferences
  for select
  to authenticated
  using (auth.uid() = user_id and (auth.jwt() ->> 'client_id') is null);

create policy user_preferences_insert_own_app_only
  on public.user_preferences
  for insert
  to authenticated
  with check (auth.uid() = user_id and (auth.jwt() ->> 'client_id') is null);

create policy user_preferences_update_own_app_only
  on public.user_preferences
  for update
  to authenticated
  using (auth.uid() = user_id and (auth.jwt() ->> 'client_id') is null)
  with check (auth.uid() = user_id and (auth.jwt() ->> 'client_id') is null);
