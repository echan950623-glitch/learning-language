/**
 * 背景同步引擎：把 outbox 依序送到 Supabase（drain），並在登入／啟動時把遠端資料
 * 併回本機（pull-merge）。見 ARCHITECTURE.md「資料流總覽」。
 *
 * 設計原則：
 * - drain 永遠「一次一筆、依序、await 完成才處理下一筆」——這不只是簡單好懂，
 *   也是 migration 需要 review_attempts 的 `seq`（DB identity 欄位）保留正確插入順序的
 *   前提（見 migration.ts），兩者共用同一個 drain 實作，不是巧合。
 * - 對外只暴露一個小小的狀態物件＋訂閱機制（idle/syncing/error/offline + pending count），
 *   UI（SyncStatusBanner）用 `useSyncExternalStore` 訂閱即可，不需要知道 outbox／Supabase
 *   的任何細節。
 * - pull-merge 直接操作 `schema.ts` 匯出的 `PersistedStore` 讀寫工具（跟
 *   `LocalStorageLearningRepository` 讀同一個 localStorage key、跑同一套 sanitize），
 *   不碰 `BaseLearningRepository`／`LocalStorageLearningRepository` 的任何內部狀態——
 *   那兩個 class 完全不變（見 ARCHITECTURE.md 核心決策）。合併後由呼叫端（repository/index.ts
 *   的 `configureCloudSync`）重新 `new LocalStorageLearningRepository()` 換一份會讀到新資料的
 *   實例，等同「reload」，不需要也不應該讓這兩個 class 多長出一個 reload 方法。
 */

import type { AbilityKind, LearningItem, ReviewAttempt, ScheduleState, StudySession } from "../../domain/types";
import { nowIso } from "../../domain/time";
import {
  readPersistedStore,
  writePersistedStore,
  SCHEMA_VERSION,
  type PersistedStore,
} from "../schema";
import {
  enqueueOutboxEntry,
  listOutboxEntries,
  markOutboxEntryFailed,
  outboxPendingCount,
  preferencesToRow,
  removeOutboxEntry,
  rowToLearningItem,
  rowToReviewAttempt,
  rowToScheduleState,
  rowToStudySessionShell,
  setOutboxEntries,
  type LearningItemRow,
  type OutboxEntry,
  type ReviewAttemptRow,
  type ScheduleStateRow,
  type StudySessionRow,
} from "./outbox";
import {
  checkItemFieldsCompatible,
  decideContentKeyConflict,
  isContentKeyConflict,
  mergeLearningItemPatch,
} from "./duplicateItemResolution";
import {
  commitItemAlias,
  loadAliasStore,
  recordUnresolvedItemConflict,
  translateIncomingAttempt,
  translateIncomingItem,
  translateIncomingSchedule,
  translateIncomingSession,
  translateOutgoingOperation,
} from "./alias";

// supabase-js 的型別（Database 預設是 any），只用來標註「這是一個真正的 Supabase client」，
// 不依賴任何尚未產生的 generated types。測試時傳入結構相容的假 client 並用
// `as unknown as SupabaseClient` 轉型即可，見 syncEngine.test.ts。
import type { SupabaseClient } from "@supabase/supabase-js";

// ---------------------------------------------------------------------------
// 同步狀態（idle/syncing/error/offline + pending count），供 UI 訂閱
// ---------------------------------------------------------------------------

export type SyncPhase = "idle" | "syncing" | "error" | "offline";

export interface SyncStatus {
  /**
   * 是否目前有設定雲端同步（已登入）。`phase`／`pendingCount` 在未設定時固定是
   * `idle`／`0`，跟「已登入且完全同步」在數值上無法區分，UI（SyncStatusBanner）要用
   * 這個欄位決定要不要整個不顯示，不能只看 `phase`。
   */
  enabled: boolean;
  phase: SyncPhase;
  pendingCount: number;
  /** zh-TW，只有 error／offline 時才有意義；idle／syncing 不需要文字說明。 */
  message?: string;
  /** 最近一次完整 drain 成功的時間，ISO 字串。 */
  lastSyncedAt?: string;
}

type SyncStatusListener = (status: SyncStatus) => void;

let currentStatus: SyncStatus = { enabled: false, phase: "idle", pendingCount: 0 };
const listeners = new Set<SyncStatusListener>();

function setStatus(next: SyncStatus): void {
  currentStatus = next;
  for (const listener of listeners) listener(currentStatus);
}

export function getSyncStatus(): SyncStatus {
  return currentStatus;
}

export function subscribeSyncStatus(listener: SyncStatusListener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

// ---------------------------------------------------------------------------
// 呼叫 Supabase 的錯誤分類（401 → 需要重新登入；5xx／無 status → 視為離線稍後重試）
// ---------------------------------------------------------------------------

class SyncCallError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "SyncCallError";
    this.status = status;
  }
}

function classifyError(error: unknown): { kind: "offline" | "auth" | "error"; message: string } {
  if (error instanceof SyncCallError) {
    if (error.status === 401) {
      return { kind: "auth", message: "登入狀態已失效，請重新登入後再試一次。" };
    }
    if (error.status === 0 || error.status >= 500) {
      return { kind: "offline", message: "暫時無法連上伺服器，稍後會自動重試。" };
    }
    return { kind: "error", message: error.message || "同步失敗，稍後會自動重試。" };
  }
  // 沒有 status 可用的錯誤（例如 fetch 本身丟出的網路層錯誤）一律視為離線。
  return { kind: "offline", message: "網路連線異常，稍後會自動重試。" };
}

// ---------------------------------------------------------------------------
// drain：依序把 outbox 最舊的一筆送到 Supabase
// ---------------------------------------------------------------------------

interface SupabaseCallResult {
  error: { message: string; code?: string | null; details?: string | null } | null;
  status: number;
}

let transientDrainUserId: string | null = null;

async function runSupabaseCall(supabase: SupabaseClient, entry: OutboxEntry): Promise<SupabaseCallResult> {
  const aliasUserId = activeConfig?.userId ?? transientDrainUserId;
  const aliases = aliasUserId ? loadAliasStore(aliasUserId) : null;
  if (aliases && entry.type === "upsert_item") {
    const canonicalId = aliases.items.find((alias) => alias.localId === entry.payload.id)?.canonicalId;
    if (canonicalId) {
      // migration 重試可能再次 enqueue 原始本機 item。journal 已證明這個 ID 有 canonical
      // 對應，但仍要重新讀取並核對內容，不能因為有 alias 就盲目丟掉這筆操作。
      const winner = await fetchRemoteItemByContentKey(supabase, entry.payload);
      if (!winner || winner.id !== canonicalId) {
        return { error: { message: "sync_conflict:aliased_item_missing" }, status: 409 };
      }
      const compatibility = checkItemFieldsCompatible(winner, entry.payload);
      if (!compatibility.compatible) {
        return { error: { message: "sync_conflict:aliased_item_changed" }, status: 409 };
      }
      const patch = mergeLearningItemPatch(winner, entry.payload);
      if (patch) {
        const updated = await supabase.from("learning_items").update(patch).eq("id", canonicalId).eq("user_id", entry.payload.user_id);
        if (updated.error) return updated;
      }
      return { error: null, status: 200 };
    }
  }
  const operation = aliases ? translateOutgoingOperation(entry, aliases) : entry;
  switch (operation.type) {
    case "upsert_item":
      return supabase.rpc("upsert_learning_item_guarded", { payload: operation.payload });
    case "delete_items":
      return supabase.rpc("delete_learning_items_guarded", { payload: operation.payload });
    case "upsert_schedule_state":
      return supabase.rpc("upsert_schedule_state_guarded", { payload: operation.payload });
    case "upsert_session":
      return supabase.rpc("upsert_study_session_guarded", { payload: operation.payload });
    case "abandon_session":
      return supabase.rpc("abandon_study_session_guarded", { payload: operation.payload });
    case "record_graded_attempt":
      return supabase.rpc("record_graded_attempt", { payload: operation.payload });
    case "mark_attempt_correct":
      return supabase.rpc("mark_attempt_correct", { payload: operation.payload });
    case "upsert_preferences":
      return supabase.rpc("upsert_preferences_guarded", { payload: operation.payload });
    case "upsert_review_attempt":
      return supabase.rpc("upsert_review_attempt_guarded", { payload: operation.payload });
  }
}

type StepOutcome =
  | { outcome: "empty" }
  | { outcome: "advanced" }
  | { outcome: "failed"; kind: "offline" | "auth" | "error"; message: string };

// ---------------------------------------------------------------------------
// content-key 衝突解決（見 duplicateItemResolution.ts 開頭的完整背景說明）
// ---------------------------------------------------------------------------

async function fetchRemoteItemByContentKey(
  supabase: SupabaseClient,
  payload: LearningItemRow
): Promise<LearningItemRow | null> {
  let query = supabase
    .from("learning_items")
    .select("*")
    .eq("user_id", payload.user_id)
    .eq("language", payload.language)
    .eq("type", payload.type)
    .eq("prompt_zh", payload.prompt_zh)
    .eq("answer", payload.answer);
  query = payload.reading === null ? query.is("reading", null) : query.eq("reading", payload.reading);

  const { data, error } = await query.maybeSingle();
  if (error) throw new SyncCallError(0, error.message);
  return (data as LearningItemRow | null) ?? null;
}

async function fetchRemoteScheduleStatesForItem(
  supabase: SupabaseClient,
  userId: string,
  learningItemId: string
): Promise<ScheduleStateRow[]> {
  const { data, error } = await supabase
    .from("schedule_states")
    .select("*")
    .eq("user_id", userId)
    .eq("learning_item_id", learningItemId);
  if (error) throw new SyncCallError(0, error.message);
  return (data as ScheduleStateRow[] | null) ?? [];
}

async function remoteItemHasProgress(supabase: SupabaseClient, userId: string, learningItemId: string): Promise<boolean> {
  const [attempts, sessions] = await Promise.all([
    supabase.from("review_attempts").select("id").eq("user_id", userId).eq("learning_item_id", learningItemId),
    supabase.from("study_sessions").select("planned_units,new_item_ids,review_item_ids").eq("user_id", userId),
  ]);
  if (attempts.error) throw new SyncCallError(attempts.status, attempts.error.message);
  if (sessions.error) throw new SyncCallError(sessions.status, sessions.error.message);
  if ((attempts.data ?? []).length > 0) return true;
  return ((sessions.data ?? []) as Array<Pick<StudySessionRow, "planned_units" | "new_item_ids" | "review_item_ids">>).some(
    (session) =>
      session.planned_units.some((unit) => unit.learningItemId === learningItemId) ||
      session.new_item_ids.includes(learningItemId) ||
      session.review_item_ids.includes(learningItemId)
  );
}

/**
 * 偵測到 `upsert_item` 撞到 unique(user_id, content_key) 時的完整解決流程。只有雙方欄位
 * 相容且遠端沒有任何進度時，才先持久化 local→canonical alias，再移除 outbox 首筆。
 * 本機 store 與其他 outbox entry 不改 id；每次送出與 pull 時才在網路邊界翻譯。
 * 任一邊已有進度或欄位不同時，持久化完整衝突快照並保留 FIFO 首筆，不自動選邊。
 */
async function resolveContentKeyConflict(
  supabase: SupabaseClient,
  headEntry: OutboxEntry & { type: "upsert_item" }
): Promise<StepOutcome> {
  try {
    const winner = await fetchRemoteItemByContentKey(supabase, headEntry.payload);
    if (!winner) {
      // 極短暫的時間差（例如剛好另一個交易還沒完全可見）：當成一般錯誤稍後重試，
      // 不嘗試臆測一個目前查不到的對應。
      return {
        outcome: "failed",
        kind: "error",
        message: "偵測到重複的單字，但暫時無法讀取既有項目，稍後會自動重試。",
      };
    }

    const fromId = headEntry.payload.id;
    const toId = winner.id;
    if (fromId === toId) {
      // 結構上不會發生（相同 id 會由 guarded RPC 做逐欄核對）；防禦性地拒絕自己對自己的 alias。
      return { outcome: "failed", kind: "error", message: "同步發生非預期的重複鍵衝突。" };
    }

    const remoteSchedules = await fetchRemoteScheduleStatesForItem(supabase, headEntry.payload.user_id, toId);
    const hasProgress =
      remoteSchedules.length > 0 ||
      (await remoteItemHasProgress(supabase, headEntry.payload.user_id, toId));
    const decision = decideContentKeyConflict({
      fieldCompatibility: checkItemFieldsCompatible(winner, headEntry.payload),
      remoteHasProgress: hasProgress,
    });
    if (decision.kind === "unresolved_conflict") {
      recordUnresolvedItemConflict(headEntry.payload.user_id, {
        localId: fromId,
        canonicalId: toId,
        reason: decision.reason,
        detail: decision.detail,
        localSnapshot: headEntry.payload,
        remoteSnapshot: winner,
      });
      const message = "同內容單字在另一台裝置已有不同資料或進度，已完整保留並停止自動合併。";
      markOutboxEntryFailed(headEntry.id, message);
      return { outcome: "failed", kind: "error", message };
    }

    const patch = mergeLearningItemPatch(winner, headEntry.payload);
    if (patch) {
      const { error: patchError } = await supabase
        .from("learning_items")
        .update(patch)
        .eq("id", toId)
        .eq("user_id", headEntry.payload.user_id);
      if (patchError) throw new SyncCallError(0, patchError.message);
    }

    // journal 先持久化；outbox 內容及本機 store 保持原始 local id。中斷後重試會先讀到
    // 同一筆 alias，再由網路邊界即時翻譯，不存在改寫一半的狀態。
    commitItemAlias(headEntry.payload.user_id, fromId, toId);
    transientDrainUserId = headEntry.payload.user_id;
    const remaining = listOutboxEntries().filter((entry) => entry.id !== headEntry.id);
    setOutboxEntries(remaining);

    return { outcome: "advanced" };
  } catch (error) {
    const classified = classifyError(error);
    markOutboxEntryFailed(headEntry.id, classified.message);
    return { outcome: "failed", kind: classified.kind, message: classified.message };
  }
}

async function drainStep(supabase: SupabaseClient): Promise<StepOutcome> {
  const entries = listOutboxEntries();
  if (entries.length === 0) return { outcome: "empty" };

  const entry = entries[0];
  try {
    const response = await runSupabaseCall(supabase, entry);
    if (response.error) {
      if (entry.type === "upsert_item" && isContentKeyConflict(response.error)) {
        return resolveContentKeyConflict(supabase, entry as OutboxEntry & { type: "upsert_item" });
      }
      throw new SyncCallError(response.status, response.error.message);
    }
    removeOutboxEntry(entry.id);
    return { outcome: "advanced" };
  } catch (error) {
    const classified = classifyError(error);
    markOutboxEntryFailed(entry.id, classified.message);
    return { outcome: "failed", kind: classified.kind, message: classified.message };
  }
}

export interface DrainOutcome {
  success: boolean;
  kind?: "offline" | "auth" | "error";
  message?: string;
}

/**
 * migration（`runInitialMigration`）跟背景 `kick()` 都會呼叫 `drainOutboxFully`，兩者原本
 * 完全獨立、沒有任何互斥——登入當下 `configureCloudSync` 觸發的背景 `kick()` 有機會跟緊接著
 * 呼叫的 `runInitialMigration` 同時各自跑一輪 drain，兩者都在讀/寫同一個 outbox
 * localStorage key，會互相讀到對方寫到一半的中間狀態（例如兩邊都把 entries[0] 讀成同一筆、
 * 都嘗試送出、都各自呼叫 removeOutboxEntry）。這裡用一條共用的 promise chain 把所有
 * `drainOutboxFully` 呼叫序列化，讓同一時間永遠只有一輪 drain 真的在跑，不需要改動任何
 * 呼叫端的呼叫方式。
 */
let drainChain: Promise<unknown> = Promise.resolve();

function runExclusiveDrain<T>(task: () => Promise<T>): Promise<T> {
  const run = drainChain.then(task, task);
  // 不論這次成功或失敗，都要讓 chain 繼續往下走，否則後面排隊的呼叫會永遠卡住；
  // 呼叫端仍然拿得到 `run` 原始的 resolve/reject，這裡吸收的只是 chain 內部的狀態。
  drainChain = run.then(
    () => undefined,
    () => undefined
  );
  return run;
}

/**
 * 一路 drain 到 outbox 淨空，或遇到第一筆失敗就停止（失敗那筆連同之後的都留在佇列裡，
 * 依 FIFO 順序，下次呼叫會從同一筆重新開始，不會跳過)。migration 用這個直接 await 到底；
 * 背景 `kick()` 也是呼叫這個，差別只在誰在乎回傳值、失敗後要不要排程重試。
 */
export async function drainOutboxFully(
  supabase: SupabaseClient,
  onStep?: (pendingCount: number) => void,
  userId?: string
): Promise<DrainOutcome> {
  return runExclusiveDrain(async () => {
    try {
      if (userId) transientDrainUserId = userId;
      for (;;) {
        const step = await drainStep(supabase);
        if (step.outcome === "empty") return { success: true };
        if (step.outcome === "failed") return { success: false, kind: step.kind, message: step.message };
        onStep?.(outboxPendingCount());
      }
    } finally {
      // 直接 migration drain（沒有 activeConfig）只在這一輪暫存 userId；不可洩漏到下一個帳戶。
      transientDrainUserId = null;
    }
  });
}

// ---------------------------------------------------------------------------
// 背景 kick：非阻塞觸發 drain，失敗時指數退避重試
// ---------------------------------------------------------------------------

export interface SyncEngineConfig {
  supabase: SupabaseClient;
  userId: string;
}

const INITIAL_RETRY_DELAY_MS = 5_000;
const MAX_RETRY_DELAY_MS = 5 * 60_000;

let activeConfig: SyncEngineConfig | null = null;
let draining = false;
let retryDelayMs = INITIAL_RETRY_DELAY_MS;
let retryTimer: ReturnType<typeof setTimeout> | null = null;
/** 每次 configureSyncEngine 遞增；讓「換設定當下還沒 settle 的舊 drain」的結果失效。 */
let configEpoch = 0;

function clearRetryTimer(): void {
  if (retryTimer !== null) {
    clearTimeout(retryTimer);
    retryTimer = null;
  }
}

/**
 * 設定（或清除）目前使用哪個 Supabase client／使用者身分來背景同步。
 * 傳 `null`（登出）：停止背景重試、狀態回到 idle（但不清空 outbox——本機資料與待送
 * 佇列都還在，下次同一個使用者登入時可以繼續送）。
 * 傳設定：立刻嘗試把可能殘留的 outbox 送出（涵蓋「下次啟動時已登入」的情境）。
 */
export function configureSyncEngine(config: SyncEngineConfig | null): void {
  configEpoch += 1;
  clearRetryTimer();
  retryDelayMs = INITIAL_RETRY_DELAY_MS;
  activeConfig = config;
  setStatus({ enabled: config !== null, phase: "idle", pendingCount: outboxPendingCount() });
  if (config) {
    kick();
  }
}

/** 非阻塞：呼叫端（SyncingLearningRepository、偏好設定）不 await 這個函式。 */
export function kick(): void {
  const epoch = configEpoch;
  const config = activeConfig;
  if (!config || draining) return;

  draining = true;
  setStatus({ enabled: true, phase: "syncing", pendingCount: outboxPendingCount() });

  void drainOutboxFully(config.supabase, (pending) => {
    if (epoch !== configEpoch) return;
    setStatus({ enabled: true, phase: "syncing", pendingCount: pending });
  }).then((result) => {
    draining = false;

    if (epoch !== configEpoch) {
      // 設定已經換掉（例如登出後又立刻登入）：這次結果不再適用，但既然 draining 剛剛
      // 解鎖，讓「最新」設定有機會重新嘗試一次，避免它自己那次 kick() 因為撞到這個
      // 已經過期的 drain 還沒解鎖而被略過。
      kick();
      return;
    }

    if (result.success) {
      retryDelayMs = INITIAL_RETRY_DELAY_MS;
      setStatus({ enabled: true, phase: "idle", pendingCount: 0, lastSyncedAt: nowIso() });
      return;
    }

    setStatus({
      enabled: true,
      phase: result.kind === "offline" ? "offline" : "error",
      pendingCount: outboxPendingCount(),
      message: result.message,
    });
    // 401：需要使用者重新登入，自動重試沒有意義，等下次 configureSyncEngine 重新設定。
    if (result.kind !== "auth") {
      scheduleRetry();
    }
  });
}

function scheduleRetry(): void {
  const epoch = configEpoch;
  clearRetryTimer();
  retryTimer = setTimeout(() => {
    retryTimer = null;
    if (epoch !== configEpoch) return;
    retryDelayMs = Math.min(retryDelayMs * 2, MAX_RETRY_DELAY_MS);
    kick();
  }, retryDelayMs);
}

/** 偏好設定（studyPreferences.ts）在成功保存到本機之後呼叫；未設定雲端同步時是純 no-op。 */
export function notifyPreferencesChanged(preferences: { dailyQuestionCount: number; dailyNewItemCap: number }): void {
  if (!activeConfig) return;
  enqueueOutboxEntry({ type: "upsert_preferences", payload: preferencesToRow(preferences, activeConfig.userId) });
  kick();
}

/** 只給測試使用：重置模組層級狀態，避免測試之間互相汙染。 */
export function __resetSyncEngineForTests(): void {
  configEpoch += 1;
  clearRetryTimer();
  activeConfig = null;
  draining = false;
  retryDelayMs = INITIAL_RETRY_DELAY_MS;
  currentStatus = { enabled: false, phase: "idle", pendingCount: 0 };
  listeners.clear();
  drainChain = Promise.resolve();
  transientDrainUserId = null;
}

// ---------------------------------------------------------------------------
// pull-merge：登入時／app 啟動時已登入，把遠端資料併回本機
// ---------------------------------------------------------------------------

function outboxHasPendingItemChange(entries: OutboxEntry[], itemId: string): boolean {
  return entries.some((entry) => {
    if (entry.type === "upsert_item") return entry.payload.id === itemId;
    if (entry.type === "delete_items") return entry.payload.ids.includes(itemId);
    return false;
  });
}

/**
 * `mark_attempt_correct` 的 payload 只有 session_id／exercise_id，沒有直接帶
 * learning_item_id／ability；用「合併前」的本機 reviewAttempts 反查這筆修正到底影響哪個
 * (item, ability)，藉此判斷這個排程是不是「還有在飛的本機變更」。
 */
function outboxHasPendingScheduleChange(
  entries: OutboxEntry[],
  learningItemId: string,
  ability: AbilityKind,
  localAttemptsBeforeMerge: ReviewAttempt[]
): boolean {
  return entries.some((entry) => {
    if (entry.type === "upsert_schedule_state") {
      return entry.payload.learning_item_id === learningItemId && entry.payload.ability === ability;
    }
    if (entry.type === "record_graded_attempt") {
      return entry.payload.learning_item_id === learningItemId && entry.payload.ability === ability;
    }
    if (entry.type === "mark_attempt_correct") {
      const attempt = localAttemptsBeforeMerge.find(
        (a) => a.sessionId === entry.payload.session_id && a.exerciseId === entry.payload.exercise_id
      );
      if (!attempt) return false;
      const attemptAbility: AbilityKind = attempt.exerciseType === "reading" ? "reading" : "recall";
      return attempt.learningItemId === learningItemId && attemptAbility === ability;
    }
    return false;
  });
}

function outboxHasPendingSessionChange(entries: OutboxEntry[], sessionId: string): boolean {
  return entries.some((entry) => {
    if (entry.type === "upsert_session") return entry.payload.id === sessionId;
    if (entry.type === "abandon_session") return entry.payload.sessionId === sessionId;
    if (entry.type === "record_graded_attempt") return entry.payload.session_id === sessionId;
    if (entry.type === "mark_attempt_correct") return entry.payload.session_id === sessionId;
    return false;
  });
}

function outboxHasPendingAttemptCorrection(entries: OutboxEntry[], sessionId: string, exerciseId: string): boolean {
  return entries.some(
    (entry) =>
      entry.type === "mark_attempt_correct" &&
      entry.payload.session_id === sessionId &&
      entry.payload.exercise_id === exerciseId
  );
}

/** 三種情況（見 ARCHITECTURE.md「資料流總覽」）：遠端獨有→加入；雙方都有＋無待送→遠端覆蓋；雙方都有＋有待送→保留本機。 */
function mergeItems(
  localItems: LearningItem[],
  remoteRows: LearningItemRow[],
  pendingEntries: OutboxEntry[],
  aliasedLocalIds: Set<string>
): LearningItem[] {
  const remoteById = new Map(remoteRows.map((row) => [row.id, row]));
  const result: LearningItem[] = [];
  const seen = new Set<string>();

  for (const local of localItems) {
    seen.add(local.id);
    const remoteRow = remoteById.get(local.id);
    if (!remoteRow || outboxHasPendingItemChange(pendingEntries, local.id)) {
      result.push(local);
      continue;
    }
    const merged = rowToLearningItem(remoteRow);
    // canonical 項目的建立時間屬於另一台裝置；別名只統一雲端身分，不改寫本機原始紀錄時間。
    result.push(aliasedLocalIds.has(local.id) ? { ...merged, createdAt: local.createdAt } : merged);
  }
  for (const [id, row] of remoteById) {
    if (!seen.has(id)) result.push(rowToLearningItem(row));
  }
  return result;
}

function scheduleKey(learningItemId: string, ability: AbilityKind): string {
  return `${learningItemId}:${ability}`;
}

function mergeScheduleStates(
  localSchedules: ScheduleState[],
  remoteRows: ScheduleStateRow[],
  pendingEntries: OutboxEntry[],
  localAttemptsBeforeMerge: ReviewAttempt[]
): ScheduleState[] {
  const remoteByKey = new Map(remoteRows.map((row) => [scheduleKey(row.learning_item_id, row.ability), row]));
  const result: ScheduleState[] = [];
  const seen = new Set<string>();

  for (const local of localSchedules) {
    const key = scheduleKey(local.learningItemId, local.ability);
    seen.add(key);
    const remoteRow = remoteByKey.get(key);
    if (
      !remoteRow ||
      outboxHasPendingScheduleChange(pendingEntries, local.learningItemId, local.ability, localAttemptsBeforeMerge)
    ) {
      result.push(local);
      continue;
    }
    result.push(rowToScheduleState(remoteRow));
  }
  for (const [key, row] of remoteByKey) {
    if (!seen.has(key)) result.push(rowToScheduleState(row));
  }
  return result;
}

/**
 * session 的 `exerciseResults` 要嘛整段沿用本機（session 保留本機時），要嘛整段從遠端
 * `review_attempts`（依 `sequence_in_session` 排序）重建——不逐欄位合併，避免「半個本機、
 * 半個遠端」的 exerciseResults 對不上 plannedUnits 位置。
 */
function mergeSessions(
  localSessions: StudySession[],
  remoteSessionRows: StudySessionRow[],
  remoteAttemptRows: ReviewAttemptRow[],
  pendingEntries: OutboxEntry[]
): StudySession[] {
  const remoteAttemptsBySession = new Map<string, ReviewAttemptRow[]>();
  for (const row of remoteAttemptRows) {
    const list = remoteAttemptsBySession.get(row.session_id) ?? [];
    list.push(row);
    remoteAttemptsBySession.set(row.session_id, list);
  }
  for (const list of remoteAttemptsBySession.values()) {
    list.sort((a, b) => a.sequence_in_session - b.sequence_in_session);
  }

  function buildExerciseResultsFromRemote(sessionId: string): StudySession["exerciseResults"] {
    const rows = remoteAttemptsBySession.get(sessionId) ?? [];
    return rows.map((row) => ({
      exerciseId: row.exercise_id,
      learningItemId: row.learning_item_id,
      exerciseType: row.exercise_type,
      result: row.result,
      usedHint: row.used_hint,
      responseTimeMs: row.response_time_ms,
    }));
  }

  const remoteById = new Map(remoteSessionRows.map((row) => [row.id, row]));
  const result: StudySession[] = [];
  const seen = new Set<string>();

  for (const local of localSessions) {
    seen.add(local.id);
    const remoteRow = remoteById.get(local.id);
    if (!remoteRow || outboxHasPendingSessionChange(pendingEntries, local.id)) {
      result.push(local);
      continue;
    }
    result.push({ ...rowToStudySessionShell(remoteRow), exerciseResults: buildExerciseResultsFromRemote(local.id) });
  }
  for (const [id, row] of remoteById) {
    if (seen.has(id)) continue;
    result.push({ ...rowToStudySessionShell(row), exerciseResults: buildExerciseResultsFromRemote(id) });
  }
  return result;
}

function mergeReviewAttempts(
  localAttempts: ReviewAttempt[],
  remoteRows: ReviewAttemptRow[],
  pendingEntries: OutboxEntry[]
): ReviewAttempt[] {
  const remoteByKey = new Map(remoteRows.map((row) => [`${row.session_id}:${row.exercise_id}`, row]));
  const result: ReviewAttempt[] = [];
  const seenKeys = new Set<string>();

  for (const local of localAttempts) {
    const key = `${local.sessionId}:${local.exerciseId}`;
    seenKeys.add(key);
    const remoteRow = remoteByKey.get(key);
    if (!remoteRow || outboxHasPendingAttemptCorrection(pendingEntries, local.sessionId, local.exerciseId)) {
      result.push(local);
      continue;
    }
    // 沿用本機 id，不是遠端 id——這筆本來就存在本機，換 id 只會讓其他還沒更新的參照
    // （目前沒有，但沒理由無故換掉一個穩定的本機識別碼）認不出是同一筆。
    result.push({ ...rowToReviewAttempt(remoteRow), id: local.id });
  }
  for (const [key, row] of remoteByKey) {
    if (!seenKeys.has(key)) result.push(rowToReviewAttempt(row));
  }
  return result;
}

/**
 * 登入時／app 啟動時已登入：抓遠端目前使用者的所有列，併回本機 store。
 * 不處理 `user_preferences`（避免這個檔案回頭依賴 `studyPreferences.ts` 造成循環
 * import——`studyPreferences.ts` 已經依賴這個檔案的 `notifyPreferencesChanged`）；
 * 偏好設定本輪只做「本機變更 → 推上雲端」單向，見交付報告的已知簡化說明。
 */
export async function pullAndMergeRemoteData(supabase: SupabaseClient, userId: string): Promise<void> {
  setStatus({ enabled: true, phase: "syncing", pendingCount: outboxPendingCount() });
  try {
    const [itemsRes, scheduleRes, sessionsRes, attemptsRes] = await Promise.all([
      supabase.from("learning_items").select("*").eq("user_id", userId),
      supabase.from("schedule_states").select("*").eq("user_id", userId),
      supabase.from("study_sessions").select("*").eq("user_id", userId),
      supabase.from("review_attempts").select("*").eq("user_id", userId),
    ]);
    if (itemsRes.error) throw new SyncCallError(itemsRes.status, itemsRes.error.message);
    if (scheduleRes.error) throw new SyncCallError(scheduleRes.status, scheduleRes.error.message);
    if (sessionsRes.error) throw new SyncCallError(sessionsRes.status, sessionsRes.error.message);
    if (attemptsRes.error) throw new SyncCallError(attemptsRes.status, attemptsRes.error.message);

    const current = readPersistedStore();
    const pendingEntries = listOutboxEntries();
    const aliases = loadAliasStore(userId);
    const remoteItems = ((itemsRes.data ?? []) as LearningItemRow[]).map((row) => translateIncomingItem(row, aliases));
    const remoteSchedules = ((scheduleRes.data ?? []) as ScheduleStateRow[]).map((row) => translateIncomingSchedule(row, aliases));
    const remoteSessions = ((sessionsRes.data ?? []) as StudySessionRow[]).map((row) => translateIncomingSession(row, aliases));
    const remoteAttempts = ((attemptsRes.data ?? []) as ReviewAttemptRow[]).map((row) => translateIncomingAttempt(row, aliases));

    const mergedStore: PersistedStore = {
      schemaVersion: SCHEMA_VERSION,
      items: mergeItems(current.items, remoteItems, pendingEntries, new Set(aliases.items.map((alias) => alias.localId))),
      scheduleStates: mergeScheduleStates(current.scheduleStates, remoteSchedules, pendingEntries, current.reviewAttempts),
      studySessions: mergeSessions(current.studySessions, remoteSessions, remoteAttempts, pendingEntries),
      reviewAttempts: mergeReviewAttempts(current.reviewAttempts, remoteAttempts, pendingEntries),
    };

    writePersistedStore(mergedStore);
    setStatus({ enabled: true, phase: "idle", pendingCount: outboxPendingCount(), lastSyncedAt: nowIso() });
  } catch (error) {
    const classified = classifyError(error);
    setStatus({
      enabled: true,
      phase: classified.kind === "offline" ? "offline" : "error",
      pendingCount: outboxPendingCount(),
      message: classified.message,
    });
    throw error;
  }
}
