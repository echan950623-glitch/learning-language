-- 雲端化架構（2026-09-16）：record_graded_attempt／mark_attempt_correct RPC
--
-- 對應 ARCHITECTURE.md 該章節的「RPC」小節。兩者都用預設的 SECURITY INVOKER
-- （呼叫者的 RLS 照常套用，auth.uid() 是呼叫者），**絕對不要改成 SECURITY DEFINER**：
--
-- 這不只是風格選擇——SECURITY INVOKER 是「MCP 永遠不能寫入 review_attempts／
-- schedule_states／study_sessions」這條安全邊界能夠成立的根本原因。因為這兩個函式
-- 內部的 insert/update 陳述式，在 SECURITY INVOKER 下仍然要通過呼叫者身份對應的 RLS
-- 政策；如果某個 MCP／OAuth client token（帶 client_id claim）試圖直接呼叫這兩個
-- RPC，函式內對 review_attempts／schedule_states／study_sessions 的寫入會被
-- 20260916020000 建立的「...own_app_only」政策的 WITH CHECK 擋下，整個函式呼叫
-- 因例外而 rollback，不會有任何寫入。如果改成 SECURITY DEFINER，這些寫入會用函式
-- 擁有者（通常是 postgres）的身份執行，完全繞過 RLS，等於幫任何拿得到 token 的呼叫者
-- （包含 MCP）開一個可以竄改歷史作答與排程的後門。
--
-- 兩個函式都加 `set search_path = public, pg_temp` 並在函式內對所有資料表用
-- `public.` 明確 qualify，避免 search_path 竄改攻擊（Supabase linter
-- 0011_function_search_path_mutable 的建議做法），這是額外的防禦性寫法，
-- 不影響 ARCHITECTURE.md 描述的行為。
--
-- RPC 不重新計算 SRS 數學（客戶端已經用 src/domain/srs.ts 算好最終結果），只重新核對
-- 結構性不變量：session 存在且 in_progress、sequence_in_session 與 planned_units
-- 對得上、冪等性。任一步驟 raise exception 都會讓整個函式的效果自動 rollback
-- （Postgres 函式呼叫本身就是單一陳述式的事務邊界）。

-- ---------------------------------------------------------------------------
-- record_graded_attempt
-- ---------------------------------------------------------------------------

create or replace function public.record_graded_attempt(payload jsonb)
returns jsonb
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  v_user_id              uuid := auth.uid();

  v_session_id           text := payload ->> 'session_id';
  v_learning_item_id     text := payload ->> 'learning_item_id';
  v_ability              text := payload ->> 'ability';
  v_exercise_id          text := payload ->> 'exercise_id';
  v_exercise_type        text := payload ->> 'exercise_type';
  v_result               text := payload ->> 'result';
  v_used_hint            boolean := (payload ->> 'used_hint')::boolean;
  v_response_time_ms     integer := (payload ->> 'response_time_ms')::integer;
  v_reviewed_at          timestamptz := (payload ->> 'reviewed_at')::timestamptz;

  v_due_at               timestamptz := (payload -> 'schedule' ->> 'due_at')::timestamptz;
  v_interval_days        integer := (payload -> 'schedule' ->> 'interval_days')::integer;
  v_streak               integer := (payload -> 'schedule' ->> 'streak')::integer;
  v_lapse_count          integer := (payload -> 'schedule' ->> 'lapse_count')::integer;

  v_item_status          text := payload ->> 'item_status';
  v_session_completed    boolean := (payload ->> 'session_completed')::boolean;
  v_session_completed_at timestamptz := (payload ->> 'session_completed_at')::timestamptz;

  v_session              public.study_sessions%rowtype;
  v_item_language        text;
  v_expected_index       integer;
  v_expected_unit        jsonb;
  v_existing_attempt_id  text;
  v_new_id               text;
  v_attempt              public.review_attempts%rowtype;
  v_schedule             public.schedule_states%rowtype;
  v_session_after        public.study_sessions%rowtype;
  v_current_item_status  text;
begin
  if v_user_id is null then
    raise exception 'record_graded_attempt: 需要登入（auth.uid() is null）';
  end if;

  -- session 必須存在（且屬於呼叫者，RLS 已保證）。用 for update 鎖住這一列，讓同一個
  -- session 的併發呼叫序列化，expected_index 的推導才不會被同時進行中的另一次呼叫影響。
  select *
  into v_session
  from public.study_sessions
  where id = v_session_id and user_id = v_user_id
  for update;

  if not found then
    raise exception 'record_graded_attempt: session "%" 不存在', v_session_id;
  end if;

  -- 1.（比 ARCHITECTURE.md 字面順序提前）冪等短路：這個 (session_id, exercise_id) 若已經
  -- 有 attempt，代表這是重複送出——最常見的情況正是「上一次呼叫其實已經成功寫入，只是
  -- 回應在網路上遺失，client 依離線重送機制又送了一次」。如果剛好是 session 最後一題，
  -- 上一次呼叫已經把 session 標成 completed；這裡若在冪等偵測之前先檢查
  -- status='in_progress'，會把「最後一題的安全重送」誤判成「呼叫端邏輯錯誤」而拒絕，
  -- 讓 session 最後一題永遠無法安全重送。這違背 ARCHITECTURE.md 本身反覆強調的
  -- 「on conflict do nothing 正是離線重送不會造成重複 attempt/session 的機制」的整體
  -- 意圖，所以把冪等偵測移到 in_progress 檢查之前——比照 mark_attempt_correct 本來就是
  -- 「先看是不是已經 correct（冪等），再做其餘結構性檢查」的順序，兩個 RPC 因此一致。
  -- 這是與 ARCHITECTURE.md 字面步驟順序（原文寫成 1→2→3）唯一的偏離，已在交付報告註明。
  select id
  into v_existing_attempt_id
  from public.review_attempts
  where session_id = v_session_id and exercise_id = v_exercise_id;

  if v_existing_attempt_id is not null then
    select * into v_attempt from public.review_attempts where id = v_existing_attempt_id;
    select * into v_schedule from public.schedule_states
      where learning_item_id = v_attempt.learning_item_id and ability = v_ability;
    select * into v_session_after from public.study_sessions
      where id = v_session_id and user_id = v_user_id;
    select status into v_current_item_status from public.learning_items
      where id = v_attempt.learning_item_id and user_id = v_user_id;

    return jsonb_build_object(
      'schedule', to_jsonb(v_schedule),
      'item_status', v_current_item_status,
      'attempt', to_jsonb(v_attempt),
      'session', to_jsonb(v_session_after)
    );
  end if;

  -- 到這裡代表這確實是一筆新的 attempt，才需要 session 必須是 in_progress 的保證
  -- （呼叫端邏輯錯誤，例如對已經 completed／abandoned 的 session 送出「新」評分）。
  if v_session.status <> 'in_progress' then
    raise exception 'record_graded_attempt: session "%" 已經是 %，不能再評分', v_session_id, v_session.status;
  end if;

  -- learning_item 必須存在且屬於呼叫者（RLS 已經把不屬於自己的排除在外，這裡的
  -- not found 涵蓋「不存在」與「不是自己的」兩種情況，兩者都應該被拒絕）。
  select language
  into v_item_language
  from public.learning_items
  where id = v_learning_item_id and user_id = v_user_id;

  if not found then
    raise exception 'record_graded_attempt: learningItemId "%" 不存在', v_learning_item_id;
  end if;

  -- 2. 結構性核對：這一題必須是 session 目前的下一個 planned unit
  --    （精準修復 1 的伺服器端版本，比照 baseRepository.ts 的同名檢查）。
  select count(*)
  into v_expected_index
  from public.review_attempts
  where session_id = v_session_id;

  v_expected_unit := v_session.planned_units -> v_expected_index;
  if v_expected_unit is null then
    raise exception 'record_graded_attempt: session "%" 已經沒有下一題可以評分', v_session_id;
  end if;
  if (v_expected_unit ->> 'learningItemId') <> v_learning_item_id then
    raise exception 'record_graded_attempt: 這一題應該是 learningItemId "%"，收到的是 "%"',
      (v_expected_unit ->> 'learningItemId'), v_learning_item_id;
  end if;
  if (v_expected_unit ->> 'ability') <> v_ability then
    raise exception 'record_graded_attempt: 這一題應該是 ability "%"，收到的是 "%"',
      (v_expected_unit ->> 'ability'), v_ability;
  end if;

  -- 3. 寫入 review_attempts。理論上不會撞 unique (session_id, exercise_id)（上面已經
  --    先查過一次且全程持有 session 列鎖），這裡的 on conflict do nothing 是額外一層
  --    防禦，撞到時一樣安全地走冪等 no-op 分支，而不是讓整個函式意外報錯。
  insert into public.review_attempts (
    id, user_id, session_id, sequence_in_session, exercise_id, learning_item_id,
    language, exercise_type, result, used_hint, response_time_ms, reviewed_at
  )
  values (
    'attempt_' || gen_random_uuid()::text, v_user_id, v_session_id, v_expected_index, v_exercise_id,
    v_learning_item_id, v_item_language, v_exercise_type, v_result, v_used_hint, v_response_time_ms, v_reviewed_at
  )
  on conflict (session_id, exercise_id) do nothing
  returning id into v_new_id;

  if v_new_id is null then
    select * into v_attempt from public.review_attempts
      where session_id = v_session_id and exercise_id = v_exercise_id;
    select * into v_schedule from public.schedule_states
      where learning_item_id = v_learning_item_id and ability = v_ability;
    select * into v_session_after from public.study_sessions
      where id = v_session_id and user_id = v_user_id;
    select status into v_current_item_status from public.learning_items
      where id = v_learning_item_id and user_id = v_user_id;

    return jsonb_build_object(
      'schedule', to_jsonb(v_schedule),
      'item_status', v_current_item_status,
      'attempt', to_jsonb(v_attempt),
      'session', to_jsonb(v_session_after)
    );
  end if;

  -- 4. 第一次寫入：upsert schedule_states、更新 learning_items.status、
  --    視情況把 study_sessions 標成 completed。
  insert into public.schedule_states (
    user_id, learning_item_id, ability, language, due_at, interval_days, streak, lapse_count,
    last_reviewed_at, updated_at
  )
  values (
    v_user_id, v_learning_item_id, v_ability, v_item_language, v_due_at, v_interval_days, v_streak,
    v_lapse_count, v_reviewed_at, now()
  )
  on conflict (learning_item_id, ability) do update set
    due_at = excluded.due_at,
    interval_days = excluded.interval_days,
    streak = excluded.streak,
    lapse_count = excluded.lapse_count,
    last_reviewed_at = excluded.last_reviewed_at,
    updated_at = now();

  update public.learning_items
  set status = v_item_status, updated_at = now()
  where id = v_learning_item_id and user_id = v_user_id;

  update public.study_sessions
  set status = case when v_session_completed then 'completed' else status end,
      completed_at = v_session_completed_at,
      updated_at = now()
  where id = v_session_id and user_id = v_user_id;

  select * into v_attempt from public.review_attempts
    where session_id = v_session_id and exercise_id = v_exercise_id;
  select * into v_schedule from public.schedule_states
    where learning_item_id = v_learning_item_id and ability = v_ability;
  select * into v_session_after from public.study_sessions
    where id = v_session_id and user_id = v_user_id;

  return jsonb_build_object(
    'schedule', to_jsonb(v_schedule),
    'item_status', v_item_status,
    'attempt', to_jsonb(v_attempt),
    'session', to_jsonb(v_session_after)
  );
end;
$$;

-- Supabase 專案預設會對新建函式自動授權 anon／authenticated／service_role／postgres
-- 執行權限（透過 `alter default privileges`）。這裡明確 revoke 掉 anon（未登入角色），
-- 只留 authenticated：即使 anon 呼叫這兩個函式，函式內 `auth.uid() is null` 的檢查與
-- 底層表格「to authenticated」的 RLS 政策已經會擋下所有實際效果，這一步是額外的
-- 縱深防禦，不是唯一防線。`revoke ... from public` 本身只影響 PUBLIC 這個虛擬角色，
-- 不會動到已經明確授權給 anon 的權限，所以要對 anon 額外明講。
revoke all on function public.record_graded_attempt(jsonb) from public, anon;
grant execute on function public.record_graded_attempt(jsonb) to authenticated;

comment on function public.record_graded_attempt(jsonb) is
  '單題評分：新增 ReviewAttempt＋upsert ScheduleState＋更新 LearningItem.status＋視情況'
  '完成 StudySession，單一 transaction。冪等（on conflict (session_id, exercise_id) do '
  'nothing）；不重算 SRS，只核對結構性不變量。SECURITY INVOKER——見檔案開頭註解，'
  '這是 MCP 無法寫入歷史作答的安全邊界所在。';

-- ---------------------------------------------------------------------------
-- mark_attempt_correct
-- ---------------------------------------------------------------------------

create or replace function public.mark_attempt_correct(payload jsonb)
returns jsonb
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  v_user_id                 uuid := auth.uid();

  v_session_id              text := payload ->> 'session_id';
  v_exercise_id             text := payload ->> 'exercise_id';

  v_due_at                  timestamptz := (payload -> 'schedule' ->> 'due_at')::timestamptz;
  v_interval_days           integer := (payload -> 'schedule' ->> 'interval_days')::integer;
  v_streak                  integer := (payload -> 'schedule' ->> 'streak')::integer;
  v_lapse_count             integer := (payload -> 'schedule' ->> 'lapse_count')::integer;
  v_item_status             text := payload ->> 'item_status';

  v_session                 public.study_sessions%rowtype;
  v_attempt                 public.review_attempts%rowtype;
  v_ability                 text;
  v_schedule                public.schedule_states%rowtype;
  v_has_newer_in_session    boolean;
  v_has_newer_for_ability   boolean;
  v_current_item_status     text;
begin
  if v_user_id is null then
    raise exception 'mark_attempt_correct: 需要登入（auth.uid() is null）';
  end if;

  select *
  into v_session
  from public.study_sessions
  where id = v_session_id and user_id = v_user_id
  for update;

  if not found then
    raise exception 'mark_attempt_correct: sessionId "%" 不存在', v_session_id;
  end if;

  -- 1. 找到目標 attempt（必須屬於呼叫者；RLS 已保證，這裡的條件是雙重保險）。
  select *
  into v_attempt
  from public.review_attempts
  where session_id = v_session_id and exercise_id = v_exercise_id and user_id = v_user_id
  for update;

  if not found then
    raise exception 'mark_attempt_correct: exerciseId "%" 不是 session "%" 的作答紀錄', v_exercise_id, v_session_id;
  end if;

  v_ability := case when v_attempt.exercise_type = 'reading' then 'reading' else 'recall' end;

  -- 2. 冪等：已經是 correct，原樣回傳現況，不做任何寫入。
  if v_attempt.result = 'correct' then
    select *
    into v_schedule
    from public.schedule_states
    where learning_item_id = v_attempt.learning_item_id and ability = v_ability;

    if not found then
      raise exception 'mark_attempt_correct: learningItemId "%" 的 "%" 排程狀態不存在，資料不一致',
        v_attempt.learning_item_id, v_ability;
    end if;

    select status into v_current_item_status
    from public.learning_items
    where id = v_attempt.learning_item_id;

    return jsonb_build_object(
      'schedule', to_jsonb(v_schedule),
      'item_status', v_current_item_status,
      'attempt', to_jsonb(v_attempt),
      'session', to_jsonb(v_session)
    );
  end if;

  -- 3. 必須是這個 session 目前最後一筆（修正窗口是「下一題之前」）。
  select exists (
    select 1 from public.review_attempts
    where session_id = v_session_id and sequence_in_session > v_attempt.sequence_in_session
  )
  into v_has_newer_in_session;

  if v_has_newer_in_session then
    raise exception 'mark_attempt_correct: exerciseId "%" 不是 session "%" 目前最後一題，已經無法修正',
      v_exercise_id, v_session_id;
  end if;

  -- 4. 拒絕會讓排程倒退的修正：這個 (learning_item_id, exercise_type) 之後
  --    （不分哪個 session）不能有更新的作答——用 seq（全域插入順序），不是
  --    reviewed_at（見 review_attempts 表註解）。
  select exists (
    select 1 from public.review_attempts
    where learning_item_id = v_attempt.learning_item_id
      and exercise_type = v_attempt.exercise_type
      and seq > v_attempt.seq
  )
  into v_has_newer_for_ability;

  if v_has_newer_for_ability then
    raise exception 'mark_attempt_correct: learningItemId "%" 的 "%" 能力在這筆之後已經有更新的作答紀錄，修正會讓目前排程倒退，已拒絕',
      v_attempt.learning_item_id, v_ability;
  end if;

  -- 5. 通過全部檢查：原地把這筆 attempt 改判為 correct，upsert 排程，更新 item 狀態。
  --    不需要更新 study_sessions（正規化後 session 本身不存 exercise_results）。
  update public.review_attempts
  set result = 'correct'
  where id = v_attempt.id;

  insert into public.schedule_states (
    user_id, learning_item_id, ability, language, due_at, interval_days, streak, lapse_count,
    last_reviewed_at, updated_at
  )
  values (
    v_user_id, v_attempt.learning_item_id, v_ability, v_attempt.language, v_due_at, v_interval_days,
    v_streak, v_lapse_count, v_attempt.reviewed_at, now()
  )
  on conflict (learning_item_id, ability) do update set
    due_at = excluded.due_at,
    interval_days = excluded.interval_days,
    streak = excluded.streak,
    lapse_count = excluded.lapse_count,
    last_reviewed_at = excluded.last_reviewed_at,
    updated_at = now();

  update public.learning_items
  set status = v_item_status, updated_at = now()
  where id = v_attempt.learning_item_id and user_id = v_user_id;

  select * into v_attempt from public.review_attempts where id = v_attempt.id;
  select * into v_schedule from public.schedule_states
    where learning_item_id = v_attempt.learning_item_id and ability = v_ability;

  return jsonb_build_object(
    'schedule', to_jsonb(v_schedule),
    'item_status', v_item_status,
    'attempt', to_jsonb(v_attempt),
    'session', to_jsonb(v_session)
  );
end;
$$;

revoke all on function public.mark_attempt_correct(jsonb) from public, anon;
grant execute on function public.mark_attempt_correct(jsonb) to authenticated;

comment on function public.mark_attempt_correct(jsonb) is
  '「我其實答對了」修正：只能改判 session 目前最後一筆、且該 (learning_item_id, '
  'exercise_type) 之後沒有更新作答的 attempt，避免排程倒退。已經是 correct 視為冪等。'
  'SECURITY INVOKER，理由同 record_graded_attempt。';
