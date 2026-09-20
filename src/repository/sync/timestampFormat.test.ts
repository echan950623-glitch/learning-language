/**
 * Supabase 回傳 timestamptz 的格式是 `2026-09-15T13:41:49.328+00:00`，不是 `...Z`。
 * 本機 store 的 `ISO_DATE_REGEX` 只接受 `Z` 結尾，所以從雲端併回來的每一列都會在
 * `sanitizeStore` 被判定為不合法而**靜默丟棄**——項目被丟掉之後，引用它的排程、作答與
 * 進行中的 session 也跟著一起被丟掉。
 *
 * 實機症狀就是這樣來的：雲端有二十幾筆 in_progress session，本機卻一筆都留不住；
 * 已經有排程的項目每次都被重新排成「新內容」；剛建立的 session 在答完第 1 題觸發
 * pull-merge 之後就消失，第 2 題送出時回報 `session_missing`。
 */

import { beforeEach, describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

import { installMockLocalStorage } from "../../test/localStorageMock";
import { createEmptyStore, readPersistedStore, writePersistedStore, type PersistedStore } from "../schema";
import { __clearOutboxForTests } from "./outbox";
import { __resetSyncEngineForTests, pullAndMergeRemoteData } from "./syncEngine";
import { __clearAliasStoreForTests } from "./alias";

const USER_ID = "user_tz";
const ITEM_ID = "item_tz_1";
const SESSION_ID = "session_tz_1";

/** PostgREST 實際回傳的形狀：時間一律帶 `+00:00` 位移，不是 `Z`。 */
const REMOTE = {
  items: [
    {
      id: ITEM_ID,
      user_id: USER_ID,
      language: "ja",
      type: "vocabulary",
      prompt_zh: "人",
      answer: "ひと",
      reading: null,
      explanation: null,
      romaji: null,
      part_of_speech: null,
      example_sentence: null,
      source: "manual",
      tags: [],
      status: "learning",
      created_at: "2026-09-15T13:41:49.328+00:00",
      is_seed: false,
    },
  ],
  schedules: [
    {
      user_id: USER_ID,
      learning_item_id: ITEM_ID,
      ability: "recall",
      language: "ja",
      due_at: "2026-10-20T18:03:57.319+00:00",
      interval_days: 30,
      streak: 13,
      lapse_count: 1,
      last_reviewed_at: "2026-09-20T18:03:57.319+00:00",
    },
  ],
  sessions: [
    {
      id: SESSION_ID,
      user_id: USER_ID,
      language: "ja",
      status: "in_progress",
      started_at: "2026-09-20T18:33:25.857+00:00",
      completed_at: null,
      planned_units: [
        { learningItemId: ITEM_ID, ability: "recall", kind: "new" },
        { learningItemId: ITEM_ID, ability: "reading", kind: "new" },
      ],
      new_item_ids: [ITEM_ID],
      review_item_ids: [],
    },
  ],
  attempts: [
    {
      id: "attempt_tz_1",
      user_id: USER_ID,
      session_id: SESSION_ID,
      sequence_in_session: 0,
      exercise_id: "exercise_tz_1",
      learning_item_id: ITEM_ID,
      language: "ja",
      exercise_type: "recall",
      result: "correct",
      used_hint: false,
      response_time_ms: 1200,
      reviewed_at: "2026-09-20T18:33:28.101+00:00",
    },
  ],
};

function remoteClient(): SupabaseClient {
  const byTable: Record<string, unknown[]> = {
    learning_items: REMOTE.items,
    schedule_states: REMOTE.schedules,
    study_sessions: REMOTE.sessions,
    review_attempts: REMOTE.attempts,
  };
  return {
    from(table: string) {
      const result = { data: byTable[table] ?? [], error: null, status: 200 };
      const builder: Record<string, unknown> = {};
      builder.select = () => builder;
      builder.eq = () => builder;
      builder.is = () => builder;
      builder.order = () => builder;
      builder.then = (onOk: (value: unknown) => unknown, onErr?: (reason: unknown) => unknown) =>
        Promise.resolve(result).then(onOk, onErr);
      return builder;
    },
  } as unknown as SupabaseClient;
}

function localStoreWithOwnSession(): PersistedStore {
  const store = createEmptyStore();
  store.items.push({
    id: ITEM_ID,
    language: "ja",
    type: "vocabulary",
    promptZh: "人",
    answer: "ひと",
    source: "manual",
    tags: [],
    status: "learning",
    createdAt: "2026-09-15T13:41:49.328Z",
    isSeed: false,
  });
  store.studySessions.push({
    id: "session_local_1",
    language: "ja",
    status: "in_progress",
    startedAt: "2026-09-20T18:33:25.857Z",
    plannedUnits: [
      { learningItemId: ITEM_ID, ability: "recall", kind: "new" },
      { learningItemId: ITEM_ID, ability: "reading", kind: "new" },
    ],
    exerciseResults: [],
    newItemIds: [ITEM_ID],
    reviewItemIds: [],
  });
  return store;
}

beforeEach(() => {
  installMockLocalStorage();
  __clearOutboxForTests();
  __resetSyncEngineForTests();
  __clearAliasStoreForTests(USER_ID);
});

describe("雲端回傳的 +00:00 時間格式", () => {
  it("併回本機之後，項目、排程、作答、session 都要保留下來", async () => {
    writePersistedStore(createEmptyStore());

    await pullAndMergeRemoteData(remoteClient(), USER_ID);

    const store = readPersistedStore();
    expect(store.items, "雲端項目不能在 sanitize 時被丟掉").toHaveLength(1);
    expect(store.scheduleStates, "雲端排程不能被丟掉").toHaveLength(1);
    expect(store.reviewAttempts, "雲端作答不能被丟掉").toHaveLength(1);
    expect(store.studySessions, "雲端 session 不能被丟掉").toHaveLength(1);
    expect(store.scheduleStates[0].streak).toBe(13);
  });

  it("時間值正規化成本機慣用的 Z 形式，不留下混合格式", async () => {
    writePersistedStore(createEmptyStore());

    await pullAndMergeRemoteData(remoteClient(), USER_ID);

    const store = readPersistedStore();
    expect(store.items[0].createdAt).toBe("2026-09-15T13:41:49.328Z");
    expect(store.scheduleStates[0].dueAt).toBe("2026-10-20T18:03:57.319Z");
    expect(store.scheduleStates[0].lastReviewedAt).toBe("2026-09-20T18:03:57.319Z");
    expect(store.reviewAttempts[0].reviewedAt).toBe("2026-09-20T18:33:28.101Z");
    expect(store.studySessions.find((s) => s.id === SESSION_ID)?.startedAt).toBe("2026-09-20T18:33:25.857Z");
  });

  it("本機自己那筆進行中的 session 不會因為合併雲端資料而消失", async () => {
    writePersistedStore(localStoreWithOwnSession());

    await pullAndMergeRemoteData(remoteClient(), USER_ID);

    const store = readPersistedStore();
    const own = store.studySessions.find((session) => session.id === "session_local_1");
    expect(own, "合併把項目換成雲端版本後，本機這筆 session 仍必須留著").toBeDefined();
    expect(own?.status).toBe("in_progress");
  });
});
