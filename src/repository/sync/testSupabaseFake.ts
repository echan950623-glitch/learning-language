/**
 * 只給 syncEngine.test.ts／migration.test.ts 使用的假 Supabase client。
 *
 * 目標是「忠實重現會讓這次修復生效或失效的那個資料庫行為」，不是完整模擬 PostgREST：
 * - `learning_items` 同時有兩組唯一鍵——`id`（大多數 upsert 呼叫指定的 onConflict 目標）
 *   跟 `(user_id, content_key)`（migration 的 20260916010000 SQL 定義的那組）。真正的
 *   Postgres 行為是：`ON CONFLICT (id) DO UPDATE` 只會攔截「id 相同」這種衝突；如果這次
 *   INSERT 撞到的是**另一組**唯一鍵（content_key），Postgres 會直接丟出 23505，
 *   `ON CONFLICT (id)` 完全不會生效——這正是這次要修的 bug 的根因，所以假 client 必須
 *   把這個行為做對，不能簡化成「upsert 永遠成功」。
 * - `schedule_states`／`study_sessions`／`review_attempts`／`user_preferences` 只有各自
 *   在 SQL 定義的那組主鍵／唯一鍵，upsert 行為單純很多。
 * - `record_graded_attempt`／`mark_attempt_correct` RPC 只做到「跟這次修復相關」的必要
 *   行為（寫入 review_attempts、upsert schedule_states、更新 learning_items.status），
 *   不追求跟 SQL 版本的每一條分支都一致——那兩個函式本身已經有 rls.test.ts 對著真實
 *   資料庫驗證過，這裡只需要讓「id remap 之後，後續操作能不能正確落地」可以被測試到。
 */

import type { LearningItemRow, ReviewAttemptRow, ScheduleStateRow, StudySessionRow, UserPreferencesRow } from "./outbox";

type Row = Record<string, unknown>;

export interface FakeError {
  message: string;
  code?: string;
  details?: string;
}

export interface FakeResult<T> {
  data: T | null;
  error: FakeError | null;
  status: number;
  count?: number;
}

function computeContentKey(row: LearningItemRow): string {
  return [row.language, row.type, row.prompt_zh, row.answer, row.reading ?? ""].join("|");
}

class FakeTable {
  rows: Row[] = [];
  constructor(
    readonly name: string,
    readonly uniqueKeySets: string[][]
  ) {}

  private conflictAgainst(row: Row, exclude?: Row): { keys: string[] } | null {
    for (const keys of this.uniqueKeySets) {
      const match = this.rows.find((existing) => existing !== exclude && keys.every((k) => existing[k] === row[k]));
      if (match) return { keys };
    }
    return null;
  }

  upsert(payload: Row[], onConflict: string[]): FakeResult<Row[]> {
    for (const incoming of payload) {
      const row = this.name === "learning_items" ? { ...incoming, content_key: computeContentKey(incoming as unknown as LearningItemRow) } : incoming;
      const target = this.rows.find((existing) => onConflict.every((k) => existing[k] === row[k]));
      if (target) {
        const conflict = this.conflictAgainst(row, target);
        if (conflict && conflict.keys.join(",") !== onConflict.join(",")) {
          return { data: null, error: buildUniqueViolation(this.name, conflict.keys), status: 409 };
        }
        Object.assign(target, row);
      } else {
        const conflict = this.conflictAgainst(row);
        if (conflict) {
          return { data: null, error: buildUniqueViolation(this.name, conflict.keys), status: 409 };
        }
        this.rows.push({ ...row });
      }
    }
    return { data: payload, error: null, status: 201 };
  }
}

function buildUniqueViolation(table: string, keys: string[]): FakeError {
  return {
    code: "23505",
    message: `duplicate key value violates unique constraint "${table}_${keys.join("_")}_key"`,
    details: `Key (${keys.join(", ")})=(...) already exists.`,
  };
}

type Filter = (row: Row) => boolean;

class FakeQueryBuilder<T = Row> implements PromiseLike<FakeResult<T[]>> {
  private filters: Filter[] = [];
  private mode: "select" | "upsert" | "update" | "delete" = "select";
  private wantCount = false;
  private upsertPayload: Row[] = [];
  private onConflictCols: string[] = ["id"];
  private updatePatch: Row | null = null;

  constructor(private readonly table: FakeTable) {}

  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- 只是為了跟真實 supabase-js 呼叫簽章相容，這個假 client 不需要真的挑欄位。
  select(columns = "*", options?: { count?: "exact"; head?: boolean }): this {
    if (this.mode === "select") this.mode = "select";
    if (options?.count) this.wantCount = true;
    return this;
  }

  eq(column: string, value: unknown): this {
    this.filters.push((row) => row[column] === value);
    return this;
  }

  is(column: string, value: null): this {
    this.filters.push((row) => (row[column] ?? null) === value);
    return this;
  }

  in(column: string, values: unknown[]): this {
    this.mode = "delete";
    this.filters.push((row) => values.includes(row[column]));
    return this;
  }

  upsert(payload: Row | Row[], options?: { onConflict?: string }): this {
    this.mode = "upsert";
    this.upsertPayload = Array.isArray(payload) ? payload : [payload];
    this.onConflictCols = (options?.onConflict ?? "id").split(",");
    return this;
  }

  update(patch: Row): this {
    this.mode = "update";
    this.updatePatch = patch;
    return this;
  }

  delete(): this {
    this.mode = "delete";
    return this;
  }

  async maybeSingle(): Promise<FakeResult<T>> {
    const result = await this.execute();
    const rows = (result.data ?? []) as unknown as Row[];
    if (rows.length > 1) {
      return { data: null, error: { message: "multiple rows returned", code: "PGRST116" }, status: 406 };
    }
    return { data: (rows[0] ?? null) as T | null, error: result.error, status: result.status };
  }

  then<TResult1 = FakeResult<T[]>, TResult2 = never>(
    onfulfilled?: ((value: FakeResult<T[]>) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null
  ): PromiseLike<TResult1 | TResult2> {
    return this.execute().then(onfulfilled, onrejected);
  }

  private matching(): Row[] {
    return this.table.rows.filter((row) => this.filters.every((f) => f(row)));
  }

  private async execute(): Promise<FakeResult<T[]>> {
    switch (this.mode) {
      case "select": {
        const rows = this.matching();
        return { data: rows as unknown as T[], error: null, status: 200, count: this.wantCount ? rows.length : undefined };
      }
      case "upsert": {
        const result = this.table.upsert(this.upsertPayload, this.onConflictCols);
        return result as unknown as FakeResult<T[]>;
      }
      case "update": {
        const rows = this.matching();
        for (const row of rows) Object.assign(row, this.updatePatch);
        return { data: rows as unknown as T[], error: null, status: 200 };
      }
      case "delete": {
        const toRemove = new Set(this.matching());
        this.table.rows = this.table.rows.filter((row) => !toRemove.has(row));
        return { data: null, error: null, status: 200 };
      }
    }
  }
}

// ---------------------------------------------------------------------------
// RPC：只做到跟這次修復相關的必要行為，見檔案開頭說明。
// ---------------------------------------------------------------------------

interface RpcRecordGradedAttemptPayload {
  attempt_id: string;
  session_id: string;
  learning_item_id: string;
  ability: string;
  exercise_id: string;
  exercise_type: string;
  result: string;
  used_hint: boolean;
  response_time_ms: number;
  reviewed_at: string;
  expected_schedule: { due_at: string; interval_days: number; streak: number; lapse_count: number; last_reviewed_at: string | null } | null;
  schedule: { due_at: string; interval_days: number; streak: number; lapse_count: number };
  item_status: string;
  session_completed: boolean;
  session_completed_at: string | null;
}

interface RpcMarkAttemptCorrectPayload {
  session_id: string;
  exercise_id: string;
  expected_schedule: { due_at: string; interval_days: number; streak: number; lapse_count: number; last_reviewed_at: string | null };
  schedule: { due_at: string; interval_days: number; streak: number; lapse_count: number };
  item_status: string;
}

export class FakeSupabaseDatabase {
  readonly tables: Record<string, FakeTable> = {
    learning_items: new FakeTable("learning_items", [["id"], ["user_id", "content_key"]]),
    schedule_states: new FakeTable("schedule_states", [["learning_item_id", "ability"]]),
    study_sessions: new FakeTable("study_sessions", [["id"]]),
    review_attempts: new FakeTable("review_attempts", [["id"], ["session_id", "exercise_id"]]),
    user_preferences: new FakeTable("user_preferences", [["user_id"]]),
  };

  table(name: string): FakeTable {
    const table = this.tables[name];
    if (!table) throw new Error(`unknown fake table: ${name}`);
    return table;
  }

  private nextAttemptSeq = 1;

  rpcRecordGradedAttempt(payload: RpcRecordGradedAttemptPayload): FakeResult<Row> {
    const session = this.tables.study_sessions.rows.find((row) => row.id === payload.session_id);
    if (!session) return { data: null, error: { message: `session "${payload.session_id}" not found` }, status: 400 };

    const existing = this.tables.review_attempts.rows.find(
      (row) => row.session_id === payload.session_id && row.exercise_id === payload.exercise_id
    );
    if (existing) {
      const schedule = this.tables.schedule_states.rows.find((row) => row.learning_item_id === payload.learning_item_id && row.ability === payload.ability);
      const exact = existing.id === payload.attempt_id && existing.learning_item_id === payload.learning_item_id && existing.result === payload.result &&
        schedule?.due_at === payload.schedule.due_at && schedule?.interval_days === payload.schedule.interval_days &&
        schedule?.streak === payload.schedule.streak && schedule?.lapse_count === payload.schedule.lapse_count;
      return exact ? { data: existing, error: null, status: 200 } : { data: null, error: { message: "sync_conflict:record_graded_attempt" }, status: 409 };
    }

    const item = this.tables.learning_items.rows.find((row) => row.id === payload.learning_item_id);
    if (!item) {
      return { data: null, error: { message: `learningItemId "${payload.learning_item_id}" not found` }, status: 400 };
    }

    const currentSchedule = this.tables.schedule_states.rows.find(
      (row) => row.learning_item_id === payload.learning_item_id && row.ability === payload.ability
    );
    const expected = payload.expected_schedule;
    const scheduleMatches = expected === null
      ? currentSchedule === undefined
      : !!currentSchedule && currentSchedule.due_at === expected.due_at && currentSchedule.interval_days === expected.interval_days &&
        currentSchedule.streak === expected.streak && currentSchedule.lapse_count === expected.lapse_count &&
        (currentSchedule.last_reviewed_at ?? null) === expected.last_reviewed_at;
    if (!scheduleMatches) return { data: null, error: { message: "sync_conflict:schedule_changed" }, status: 409 };

    const attemptRow: ReviewAttemptRow & { seq: number } = {
      id: payload.attempt_id,
      user_id: item.user_id as string,
      session_id: payload.session_id,
      sequence_in_session: this.tables.review_attempts.rows.filter((r) => r.session_id === payload.session_id).length,
      exercise_id: payload.exercise_id,
      learning_item_id: payload.learning_item_id,
      language: item.language as ReviewAttemptRow["language"],
      exercise_type: payload.exercise_type as ReviewAttemptRow["exercise_type"],
      result: payload.result as ReviewAttemptRow["result"],
      used_hint: payload.used_hint,
      response_time_ms: payload.response_time_ms,
      reviewed_at: payload.reviewed_at,
      seq: this.nextAttemptSeq,
    };
    this.nextAttemptSeq += 1;
    this.tables.review_attempts.rows.push(attemptRow as unknown as Row);

    this.tables.schedule_states.upsert(
      [
        {
          user_id: item.user_id,
          learning_item_id: payload.learning_item_id,
          ability: payload.ability,
          language: item.language,
          due_at: payload.schedule.due_at,
          interval_days: payload.schedule.interval_days,
          streak: payload.schedule.streak,
          lapse_count: payload.schedule.lapse_count,
          last_reviewed_at: payload.reviewed_at,
        },
      ],
      ["learning_item_id", "ability"]
    );

    Object.assign(item, { status: payload.item_status });
    if (payload.session_completed) {
      Object.assign(session, { status: "completed", completed_at: payload.session_completed_at });
    }

    return { data: attemptRow as unknown as Row, error: null, status: 200 };
  }

  rpcMarkAttemptCorrect(payload: RpcMarkAttemptCorrectPayload): FakeResult<Row> {
    const attempt = this.tables.review_attempts.rows.find(
      (row) => row.session_id === payload.session_id && row.exercise_id === payload.exercise_id
    );
    if (!attempt) return { data: null, error: { message: "attempt not found" }, status: 400 };
    const ability = attempt.exercise_type === "reading" ? "reading" : "recall";
    const currentSchedule = this.tables.schedule_states.rows.find(
      (row) => row.learning_item_id === attempt.learning_item_id && row.ability === ability
    );
    const expected = payload.expected_schedule;
    const scheduleMatches = !!currentSchedule && currentSchedule.due_at === expected.due_at &&
      currentSchedule.interval_days === expected.interval_days && currentSchedule.streak === expected.streak &&
      currentSchedule.lapse_count === expected.lapse_count && (currentSchedule.last_reviewed_at ?? null) === expected.last_reviewed_at;
    if (attempt.result !== "correct" && !scheduleMatches) {
      return { data: null, error: { message: "sync_conflict:schedule_changed" }, status: 409 };
    }
    Object.assign(attempt, { result: "correct" });
    this.tables.schedule_states.upsert(
      [
        {
          user_id: attempt.user_id,
          learning_item_id: attempt.learning_item_id,
          ability,
          language: attempt.language,
          due_at: payload.schedule.due_at,
          interval_days: payload.schedule.interval_days,
          streak: payload.schedule.streak,
          lapse_count: payload.schedule.lapse_count,
          last_reviewed_at: attempt.reviewed_at,
        },
      ],
      ["learning_item_id", "ability"]
    );

    const item = this.tables.learning_items.rows.find((row) => row.id === attempt.learning_item_id);
    if (item) Object.assign(item, { status: payload.item_status });

    return { data: attempt, error: null, status: 200 };
  }
}

export interface FakeSupabaseClient {
  from(table: string): FakeQueryBuilder;
  rpc(name: string, args: { payload: Row }): Promise<FakeResult<Row>>;
  __db: FakeSupabaseDatabase;
}

/** 建立一個結構相容於 `SupabaseClient` 的假 client（呼叫端一律 `as unknown as SupabaseClient` 轉型）。 */
export function createFakeSupabaseClient(db: FakeSupabaseDatabase = new FakeSupabaseDatabase()): FakeSupabaseClient {
  return {
    from(table: string) {
      return new FakeQueryBuilder(db.table(table));
    },
    async rpc(name: string, args: { payload: Row }) {
      if (name === "upsert_preferences_guarded") {
        const table = db.tables.user_preferences;
        const existing = table.rows.find((row) => row.user_id === args.payload.user_id);
        if (existing) {
          Object.assign(existing, args.payload, { updated_at: "2026-09-20T00:00:00.000Z" });
          return { data: existing, error: null, status: 200 };
        }
        const inserted = table.upsert(
          [{ ...args.payload, updated_at: "2026-09-20T00:00:00.000Z" }],
          ["user_id"]
        );
        return { data: inserted.data?.[0] ?? null, error: inserted.error, status: inserted.status };
      }
      const guardedTables: Record<string, { table: string; keys: string[]; ignored?: string[] }> = {
        upsert_learning_item_guarded: { table: "learning_items", keys: ["id"] },
        upsert_schedule_state_guarded: { table: "schedule_states", keys: ["learning_item_id", "ability"] },
        upsert_study_session_guarded: { table: "study_sessions", keys: ["id"] },
        upsert_review_attempt_guarded: { table: "review_attempts", keys: ["session_id", "exercise_id"], ignored: ["id"] },
      };
      const guarded = guardedTables[name];
      if (guarded) {
        const table = db.table(guarded.table);
        const existing = table.rows.find((row) => guarded.keys.every((key) => row[key] === args.payload[key]));
        if (existing) {
          const ignored = new Set([...(guarded.ignored ?? []), "seq", "updated_at"]);
          const different = Object.entries(args.payload).some(([key, value]) => !ignored.has(key) && JSON.stringify(existing[key]) !== JSON.stringify(value));
          return different
            ? { data: null, error: { message: `sync_conflict:${guarded.table}` }, status: 409 }
            : { data: existing, error: null, status: 200 };
        }
        const inserted = table.upsert([args.payload], guarded.keys);
        return { data: inserted.data?.[0] ?? null, error: inserted.error, status: inserted.status };
      }
      if (name === "delete_learning_items_guarded") {
        const ids = args.payload.ids as string[];
        const hasProgress = ids.some((id) =>
          db.tables.schedule_states.rows.some((row) => row.learning_item_id === id) ||
          db.tables.review_attempts.rows.some((row) => row.learning_item_id === id) ||
          db.tables.study_sessions.rows.some((row) =>
            (row.planned_units as Array<{ learningItemId: string }>).some((unit) => unit.learningItemId === id) ||
            (row.new_item_ids as string[]).includes(id) || (row.review_item_ids as string[]).includes(id)
          )
        );
        if (hasProgress) return { data: null, error: { message: "sync_conflict:delete_item_with_progress" }, status: 409 };
        db.tables.learning_items.rows = db.tables.learning_items.rows.filter((row) => !ids.includes(row.id as string));
        return { data: null, error: null, status: 200 };
      }
      if (name === "abandon_study_session_guarded") {
        const session = db.tables.study_sessions.rows.find((row) => row.id === args.payload.sessionId);
        if (!session || session.status === "completed") return { data: null, error: { message: "sync_conflict:completed_session" }, status: 409 };
        session.status = "abandoned";
        return { data: session, error: null, status: 200 };
      }
      if (name === "record_graded_attempt") {
        return db.rpcRecordGradedAttempt(args.payload as unknown as RpcRecordGradedAttemptPayload);
      }
      if (name === "mark_attempt_correct") {
        return db.rpcMarkAttemptCorrect(args.payload as unknown as RpcMarkAttemptCorrectPayload);
      }
      throw new Error(`unknown rpc: ${name}`);
    },
    __db: db,
  };
}

export type { LearningItemRow, ReviewAttemptRow, ScheduleStateRow, StudySessionRow, UserPreferencesRow };
