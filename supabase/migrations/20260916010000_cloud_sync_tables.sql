-- 雲端化架構（2026-09-16）：資料表 + 索引 + RLS 開關
--
-- 對應 ARCHITECTURE.md「雲端化架構（2026-09-16）：Supabase 同步、Auth、MCP」章節的
-- 「資料表」小節。欄位／型別／constraint／index 逐一比照該節規格，不自行增減欄位。
--
-- 設計重點（詳見 ARCHITECTURE.md，這裡只摘要）：
-- - 所有表都直接存 user_id（不用 join），RLS 判斷成本最低，也跟本機模型在每筆子紀錄
--   冗餘存 language 是同一種設計理由。
-- - id 一律用 text primary key，沿用 src/domain/id.ts 的 generateId() 格式
--   （例如 item_<uuid>），不是原生 Postgres uuid 型別。
-- - 每個表都 ENABLE + FORCE ROW LEVEL SECURITY；FORCE 是必要的，否則表的擁有者
--   （這裡是 postgres，也就是我們用來跑 migration 的角色）預設會略過 RLS。

-- ---------------------------------------------------------------------------
-- learning_items
-- ---------------------------------------------------------------------------

create table public.learning_items (
  id                text primary key,
  user_id           uuid not null references auth.users(id) on delete cascade,
  language          text not null check (language in ('ja', 'en')),
  type              text not null check (type in ('vocabulary', 'grammar', 'phrase', 'collocation')),
  prompt_zh         text not null,
  answer            text not null,
  reading           text,
  explanation       text,
  romaji            text,
  part_of_speech    text,
  example_sentence  text,
  source            text not null check (source in ('ai', 'textbook', 'teacher', 'song', 'manual')),
  tags              text[] not null default '{}',
  status            text not null check (status in ('new', 'learning', 'mastered', 'struggling')),
  created_at        timestamptz not null,
  is_seed           boolean not null default false,
  -- 跟本機 addItemsIfMissing 同一套內容去重鍵（見 src/repository/baseRepository.ts 的
  -- contentKey()）：language + type + promptZh + answer + reading。
  content_key       text generated always as (
                       language || '|' || type || '|' || prompt_zh || '|' || answer || '|' || coalesce(reading, '')
                     ) stored,
  updated_at        timestamptz not null default now(),

  unique (user_id, content_key)
);

create index learning_items_user_id_language_idx on public.learning_items (user_id, language);

alter table public.learning_items enable row level security;
alter table public.learning_items force row level security;

comment on table public.learning_items is
  '單字／文法等學習項目。對應 src/domain/types.ts 的 LearningItem。';

-- ---------------------------------------------------------------------------
-- schedule_states
-- ---------------------------------------------------------------------------

create table public.schedule_states (
  user_id           uuid not null references auth.users(id) on delete cascade,
  learning_item_id  text not null references public.learning_items(id) on delete cascade,
  ability           text not null check (ability in ('recall', 'reading')),
  language          text not null check (language in ('ja', 'en')),
  due_at            timestamptz not null,
  interval_days     integer not null check (interval_days > 0),
  streak            integer not null check (streak >= 0),
  lapse_count       integer not null check (lapse_count >= 0),
  last_reviewed_at  timestamptz,
  updated_at        timestamptz not null default now(),

  primary key (learning_item_id, ability)
);

create index schedule_states_user_id_due_at_idx on public.schedule_states (user_id, due_at);

alter table public.schedule_states enable row level security;
alter table public.schedule_states force row level security;

comment on table public.schedule_states is
  '每個 (learning_item_id, ability) 一筆的 SRS 排程狀態。對應 src/domain/types.ts 的 ScheduleState。';

-- ---------------------------------------------------------------------------
-- study_sessions
-- ---------------------------------------------------------------------------

create table public.study_sessions (
  id               text primary key,
  user_id          uuid not null references auth.users(id) on delete cascade,
  language         text not null check (language in ('ja', 'en')),
  status           text not null check (status in ('in_progress', 'completed', 'abandoned')),
  started_at       timestamptz not null,
  completed_at     timestamptz,
  -- [{learningItemId, ability, kind}]，跟本機 StudySessionPlannedUnit[] 同形狀。
  planned_units    jsonb not null,
  new_item_ids     text[] not null default '{}',
  review_item_ids  text[] not null default '{}',
  updated_at       timestamptz not null default now()
);

alter table public.study_sessions enable row level security;
alter table public.study_sessions force row level security;

comment on table public.study_sessions is
  '一次「今日學習」的固定題目順序與進度。不存 exercise_results——正規化拆進 '
  'review_attempts，見該表的 sequence_in_session／seq 欄位。對應 StudySession。';

-- ---------------------------------------------------------------------------
-- review_attempts
-- ---------------------------------------------------------------------------

create table public.review_attempts (
  id                    text primary key,
  user_id               uuid not null references auth.users(id) on delete cascade,
  session_id            text not null references public.study_sessions(id) on delete cascade,
  -- 0-based，對應 study_sessions.planned_units 的位置。
  sequence_in_session   integer not null,
  -- 全域插入順序（不是時間戳記），mark_attempt_correct 用它判斷「這個 (learning_item_id,
  -- exercise_type) 之後有沒有更新的作答」，對應本機用陣列插入順序判斷
  -- hasNewerAttemptForSameAbility 的邏輯。
  seq                   bigint generated always as identity,
  exercise_id           text not null,
  learning_item_id      text not null references public.learning_items(id) on delete cascade,
  language              text not null check (language in ('ja', 'en')),
  exercise_type         text not null check (exercise_type in ('recall', 'reading', 'spelling', 'translation')),
  result                text not null check (result in ('correct', 'partial', 'incorrect')),
  used_hint             boolean not null,
  response_time_ms      integer not null check (response_time_ms >= 0),
  reviewed_at           timestamptz not null,

  -- 冪等：同一題在同一 session 只能記一次。
  unique (session_id, exercise_id),
  unique (session_id, sequence_in_session)
);

create index review_attempts_user_learning_item_exercise_type_seq_idx
  on public.review_attempts (user_id, learning_item_id, exercise_type, seq);
create index review_attempts_user_id_reviewed_at_idx
  on public.review_attempts (user_id, reviewed_at);

alter table public.review_attempts enable row level security;
alter table public.review_attempts force row level security;

comment on table public.review_attempts is
  '正規化後的單題作答歷史紀錄。對應 src/domain/types.ts 的 ReviewAttempt。';

-- ---------------------------------------------------------------------------
-- user_preferences
-- ---------------------------------------------------------------------------

create table public.user_preferences (
  user_id                 uuid primary key references auth.users(id) on delete cascade,
  daily_question_count    integer not null default 10 check (daily_question_count in (5, 10, 15, 20)),
  daily_new_item_cap      integer not null default 10 check (daily_new_item_cap > 0 and daily_new_item_cap <= 50),
  updated_at              timestamptz not null default now()
);

alter table public.user_preferences enable row level security;
alter table public.user_preferences force row level security;

comment on table public.user_preferences is
  '每位使用者的學習偏好設定（每日題數、每日新字上限）。';
