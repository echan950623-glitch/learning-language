/**
 * 帳號範圍的「本機 id ←→ 雲端 canonical id」別名（alias）＋ recovery journal。
 *
 * 背景（見 `.claude/google-sync-review-handoff.md`＋ARCHITECTURE.md「content-key 衝突」一節）：
 * 舊版做法是偵測到 content-key 衝突時，直接把本機 store／outbox 裡的「輸家」id 全面改寫成
 * 「贏家」id——這會製造多重風險：held repository instance 拿舊 id 寫入會把改寫蓋掉、
 * 排程用「比較新」規則自動選邊會靜默丟掉另一邊的待送操作、而且一旦本機 store 改寫完成、
 * outbox 改寺失敗，兩邊就會暫時性地不一致。
 *
 * 這裡改成：**本機 id 永遠不變**。衝突解決只新增一筆「這個本機 id 對應到這個雲端 id」的別名
 * 記錄，實際的 id 翻譯只發生在「送出到 Supabase 的那一刻」（把本機 id 換成 canonical id）與
 * 「從 Supabase 併回本機的那一刻」（把 canonical id 換回本機 id），也就是網路邊界——不論是
 * 本機 store 還是 outbox 裡任何一筆已經存在／之後才 enqueue 的操作，永遠維持它原本寫入時的
 * 本機 id，本身完全不會被這裡的任何函式改寫。這同時也讓 outbox 的 id／內容天生穩定
 * （不需要 remap 出一份新的 outbox entry），中斷在任何時間點重試都只是「重新查一次目前的
 * 別名表」，不存在「remap 做到一半」的中間狀態。
 *
 * 持久化採「journal 為準、alias 表只是可重建的 cache」：
 * - journal（`sync-alias-journal:<userId>`）是 append-only 的決策記錄，每筆都足以重新推導出
 *   完整的別名表。
 * - alias 表（`sync-alias:<userId>`）是 journal fold 出來的結果，只是為了查詢方便而快取；
 *   每次讀取都會從 journal 重建並寫回快取；任何讀寫失敗都會中止同步，避免在無法確認
 *   canonical id 對應的情況下繼續送出資料。
 *   這讓「journal 已經寫入成功、但快取表那次 setItem 沒有發生（分頁在兩次寫入中間關掉）」
 *   這種中斷永遠可以在下一次讀取時自我修復，不需要額外的復原流程。
 *
 * 帳號範圍（key 帶 userId）：同一台瀏覽器換帳號登入不會讓兩個使用者的別名互相污染。
 */

import { generateId } from "../../domain/id";
import { nowIso } from "../../domain/time";
import type { LearningItemRow, OutboxOperation, ReviewAttemptRow, ScheduleStateRow, StudySessionRow } from "./outbox";

const ALIAS_KEY_PREFIX = "learning-language:sync-alias:";
const JOURNAL_KEY_PREFIX = "learning-language:sync-alias-journal:";

export interface ItemAlias {
  localId: string;
  canonicalId: string;
  createdAt: string;
}

export interface AttemptAlias {
  sessionId: string;
  exerciseId: string;
  /** 實際落地的遠端 review_attempts.id；record_graded_attempt RPC 會指派跟本機不同的隨機 id。 */
  canonicalAttemptId: string;
  createdAt: string;
}

export type ConflictReason = "fields_incompatible" | "remote_has_progress";

export interface UnresolvedItemConflict {
  id: string;
  localId: string;
  canonicalId: string;
  reason: ConflictReason;
  /** 中文說明，給未來的人工解決介面／除錯使用。 */
  detail: string;
  localSnapshot: LearningItemRow;
  remoteSnapshot: LearningItemRow;
  createdAt: string;
}

type JournalEntry =
  | { id: string; kind: "item_alias"; createdAt: string; localId: string; canonicalId: string }
  | { id: string; kind: "item_conflict"; createdAt: string; conflict: UnresolvedItemConflict }
  | {
      id: string;
      kind: "attempt_alias";
      createdAt: string;
      sessionId: string;
      exerciseId: string;
      canonicalAttemptId: string;
    };

export interface AliasStoreSnapshot {
  items: ItemAlias[];
  attempts: AttemptAlias[];
  conflicts: UnresolvedItemConflict[];
}

function emptySnapshot(): AliasStoreSnapshot {
  return { items: [], attempts: [], conflicts: [] };
}

export class AliasPersistenceError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "AliasPersistenceError";
  }
}

function browserStorage(): Storage {
  if (typeof window === "undefined") {
    throw new AliasPersistenceError("目前無法使用本機儲存，無法安全處理同步別名");
  }
  try {
    return window.localStorage;
  } catch (error) {
    throw new AliasPersistenceError("目前無法使用本機儲存，無法安全處理同步別名", { cause: error });
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** 輕量驗證；任何 journal 毀損都會讓讀取端 fail closed，不能回退成空別名繼續同步。 */
function isJournalEntry(value: unknown): value is JournalEntry {
  if (!isRecord(value)) return false;
  if (typeof value.id !== "string" || typeof value.createdAt !== "string") return false;
  if (value.kind === "item_alias") {
    return typeof value.localId === "string" && typeof value.canonicalId === "string";
  }
  if (value.kind === "attempt_alias") {
    return (
      typeof value.sessionId === "string" &&
      typeof value.exerciseId === "string" &&
      typeof value.canonicalAttemptId === "string"
    );
  }
  if (value.kind === "item_conflict") {
    return isRecord(value.conflict) && typeof value.conflict.id === "string";
  }
  return false;
}

function readJournal(userId: string): JournalEntry[] {
  const storage = browserStorage();
  let raw: string | null;
  try {
    raw = storage.getItem(`${JOURNAL_KEY_PREFIX}${userId}`);
  } catch (error) {
    throw new AliasPersistenceError("讀取同步別名 journal 失敗，已停止同步以保留資料", { cause: error });
  }
  if (raw === null) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed) || !parsed.every(isJournalEntry)) {
      throw new AliasPersistenceError("同步別名 journal 格式損毀，已停止同步以保留資料");
    }
    return parsed;
  } catch (error) {
    if (error instanceof AliasPersistenceError) throw error;
    throw new AliasPersistenceError("同步別名 journal 不是合法 JSON，已停止同步以保留資料", { cause: error });
  }
}

/**
 * journal 寫入**不吞例外**——呼叫端（`commitItemAlias`／`recordUnresolvedConflict`／
 * `commitAttemptAlias`）必須在這裡失敗時整個中止，不能假裝別名已經生效（見「Strict backup
 * and immutable pre-migration manifest；corruption/write failure aborts」的同一個原則：
 * 任何會影響之後資料正確性的寫入，失敗就必須讓呼叫端知道並中止，不能靜默略過）。
 */
function appendJournalEntry(userId: string, entry: JournalEntry): void {
  const storage = browserStorage();
  const next = [...readJournal(userId), entry];
  try {
    storage.setItem(`${JOURNAL_KEY_PREFIX}${userId}`, JSON.stringify(next));
  } catch (error) {
    throw new AliasPersistenceError("寫入同步別名 journal 失敗，已停止同步以保留資料", { cause: error });
  }
}

function foldJournal(journal: JournalEntry[]): AliasStoreSnapshot {
  const snapshot = emptySnapshot();
  const itemByLocalId = new Map<string, ItemAlias>();
  const itemByCanonicalId = new Map<string, ItemAlias>();
  const attemptByKey = new Map<string, AttemptAlias>();
  const conflictById = new Map<string, UnresolvedItemConflict>();

  for (const entry of journal) {
    if (entry.kind === "item_alias") {
      const alias = {
        localId: entry.localId,
        canonicalId: entry.canonicalId,
        createdAt: entry.createdAt,
      };
      const byLocal = itemByLocalId.get(entry.localId);
      const byCanonical = itemByCanonicalId.get(entry.canonicalId);
      if ((byLocal && byLocal.canonicalId !== entry.canonicalId) || (byCanonical && byCanonical.localId !== entry.localId)) {
        throw new AliasPersistenceError("同步別名不是一對一對應，已停止同步以保留資料");
      }
      itemByLocalId.set(entry.localId, alias);
      itemByCanonicalId.set(entry.canonicalId, alias);
      continue;
    }
    if (entry.kind === "attempt_alias") {
      const key = `${entry.sessionId}:${entry.exerciseId}`;
      const existing = attemptByKey.get(key);
      if (existing && existing.canonicalAttemptId !== entry.canonicalAttemptId) {
        throw new AliasPersistenceError("作答別名發生矛盾，已停止同步以保留資料");
      }
      attemptByKey.set(key, {
        sessionId: entry.sessionId,
        exerciseId: entry.exerciseId,
        canonicalAttemptId: entry.canonicalAttemptId,
        createdAt: entry.createdAt,
      });
      continue;
    }
    // item_conflict：同一個 localId 之後如果被人工／未來流程解成 item_alias，上面那個
    // Map.set 天然覆蓋，不會同時既是別名又是未解決衝突。
    conflictById.set(entry.conflict.id, entry.conflict);
  }

  snapshot.items = Array.from(itemByLocalId.values());
  snapshot.attempts = Array.from(attemptByKey.values());
  const aliasedLocalIds = new Set(snapshot.items.map((a) => a.localId));
  snapshot.conflicts = Array.from(conflictById.values()).filter((c) => !aliasedLocalIds.has(c.localId));
  return snapshot;
}

function writeCache(userId: string, snapshot: AliasStoreSnapshot): void {
  const storage = browserStorage();
  try {
    storage.setItem(`${ALIAS_KEY_PREFIX}${userId}`, JSON.stringify({ schemaVersion: 1, userId, ...snapshot }));
  } catch (error) {
    throw new AliasPersistenceError("寫入同步別名快取失敗，已停止同步以保留資料", { cause: error });
  }
}

/** 對外唯一的讀取入口：永遠從 journal 重新 fold（見檔案開頭「journal 為準」說明），並嘗試更新快取。 */
export function loadAliasStore(userId: string): AliasStoreSnapshot {
  const snapshot = foldJournal(readJournal(userId));
  writeCache(userId, snapshot);
  return snapshot;
}

// ---------------------------------------------------------------------------
// 寫入 API：journal 先寫（失敗就整個中止，見 appendJournalEntry），成功後才 fold＋回傳最新結果。
// ---------------------------------------------------------------------------

export function commitItemAlias(userId: string, localId: string, canonicalId: string, now = nowIso()): AliasStoreSnapshot {
  const current = loadAliasStore(userId);
  const existing = current.items.find((alias) => alias.localId === localId || alias.canonicalId === canonicalId);
  if (existing) {
    if (existing.localId === localId && existing.canonicalId === canonicalId) return current;
    throw new AliasPersistenceError("同步別名不是一對一對應，已停止同步以保留資料");
  }
  appendJournalEntry(userId, { id: generateId("aliasj"), kind: "item_alias", createdAt: now, localId, canonicalId });
  return loadAliasStore(userId);
}

export function recordUnresolvedItemConflict(
  userId: string,
  input: {
    localId: string;
    canonicalId: string;
    reason: ConflictReason;
    detail: string;
    localSnapshot: LearningItemRow;
    remoteSnapshot: LearningItemRow;
  },
  now = nowIso()
): AliasStoreSnapshot {
  const current = loadAliasStore(userId);
  const existing = current.conflicts.find(
    (conflict) =>
      conflict.localId === input.localId &&
      conflict.canonicalId === input.canonicalId &&
      conflict.reason === input.reason
  );
  if (existing) return current;
  const conflict: UnresolvedItemConflict = { id: generateId("conflict"), createdAt: now, ...input };
  appendJournalEntry(userId, { id: generateId("aliasj"), kind: "item_conflict", createdAt: now, conflict });
  return loadAliasStore(userId);
}

export function commitAttemptAlias(
  userId: string,
  sessionId: string,
  exerciseId: string,
  canonicalAttemptId: string,
  now = nowIso()
): AliasStoreSnapshot {
  const current = loadAliasStore(userId);
  const existing = current.attempts.find((alias) => alias.sessionId === sessionId && alias.exerciseId === exerciseId);
  if (existing) {
    if (existing.canonicalAttemptId === canonicalAttemptId) return current;
    throw new AliasPersistenceError("作答別名發生矛盾，已停止同步以保留資料");
  }
  appendJournalEntry(userId, {
    id: generateId("aliasj"),
    kind: "attempt_alias",
    createdAt: now,
    sessionId,
    exerciseId,
    canonicalAttemptId,
  });
  return loadAliasStore(userId);
}

// ---------------------------------------------------------------------------
// 查詢輔助（純函式，吃已經讀好的 snapshot，方便測試與重複使用）
// ---------------------------------------------------------------------------

/** 本機 id → 送到 Supabase 時應該用的 id（沒有別名就是它自己）。 */
export function resolveCanonicalItemId(snapshot: AliasStoreSnapshot, localId: string): string {
  return snapshot.items.find((a) => a.localId === localId)?.canonicalId ?? localId;
}

/** canonical id → 本機 id（pull-merge 用；沒有別名代表這個 canonical id 本來就等於本機 id）。 */
export function resolveLocalItemIdForCanonical(snapshot: AliasStoreSnapshot, canonicalId: string): string | undefined {
  return snapshot.items.find((a) => a.canonicalId === canonicalId)?.localId;
}

export function isItemAliased(snapshot: AliasStoreSnapshot, localId: string): boolean {
  return snapshot.items.some((a) => a.localId === localId);
}

export function resolveCanonicalAttemptId(
  snapshot: AliasStoreSnapshot,
  sessionId: string,
  exerciseId: string
): string | undefined {
  return snapshot.attempts.find((a) => a.sessionId === sessionId && a.exerciseId === exerciseId)?.canonicalAttemptId;
}

function mapIds(ids: string[], snapshot: AliasStoreSnapshot): string[] {
  return ids.map((id) => resolveCanonicalItemId(snapshot, id));
}

/** 僅在送出網路邊界建立副本；原始 outbox 內容永遠保持本機 id。 */
export function translateOutgoingOperation(operation: OutboxOperation, snapshot: AliasStoreSnapshot): OutboxOperation {
  switch (operation.type) {
    case "upsert_item":
      return { ...operation, payload: { ...operation.payload, id: resolveCanonicalItemId(snapshot, operation.payload.id) } };
    case "delete_items":
      return { ...operation, payload: { ids: mapIds(operation.payload.ids, snapshot) } };
    case "upsert_schedule_state":
      return { ...operation, payload: { ...operation.payload, learning_item_id: resolveCanonicalItemId(snapshot, operation.payload.learning_item_id) } };
    case "upsert_review_attempt":
      return { ...operation, payload: { ...operation.payload, learning_item_id: resolveCanonicalItemId(snapshot, operation.payload.learning_item_id) } };
    case "record_graded_attempt":
      return {
        ...operation,
        payload: {
          ...operation.payload,
          attempt_id:
            resolveCanonicalAttemptId(snapshot, operation.payload.session_id, operation.payload.exercise_id) ??
            operation.payload.attempt_id,
          learning_item_id: resolveCanonicalItemId(snapshot, operation.payload.learning_item_id),
        },
      };
    case "upsert_session":
      return {
        ...operation,
        payload: {
          ...operation.payload,
          planned_units: operation.payload.planned_units.map((unit) => ({ ...unit, learningItemId: resolveCanonicalItemId(snapshot, unit.learningItemId) })),
          new_item_ids: mapIds(operation.payload.new_item_ids, snapshot),
          review_item_ids: mapIds(operation.payload.review_item_ids, snapshot),
        },
      };
    case "abandon_session":
    case "mark_attempt_correct":
    case "upsert_preferences":
      return operation;
  }
}

export function translateIncomingSchedule(row: ScheduleStateRow, snapshot: AliasStoreSnapshot): ScheduleStateRow {
  return { ...row, learning_item_id: resolveLocalItemIdForCanonical(snapshot, row.learning_item_id) ?? row.learning_item_id };
}

export function translateIncomingItem(row: LearningItemRow, snapshot: AliasStoreSnapshot): LearningItemRow {
  return { ...row, id: resolveLocalItemIdForCanonical(snapshot, row.id) ?? row.id };
}

export function translateIncomingAttempt(row: ReviewAttemptRow, snapshot: AliasStoreSnapshot): ReviewAttemptRow {
  return { ...row, learning_item_id: resolveLocalItemIdForCanonical(snapshot, row.learning_item_id) ?? row.learning_item_id };
}

export function translateIncomingSession(row: StudySessionRow, snapshot: AliasStoreSnapshot): StudySessionRow {
  const local = (id: string) => resolveLocalItemIdForCanonical(snapshot, id) ?? id;
  return {
    ...row,
    planned_units: row.planned_units.map((unit) => ({ ...unit, learningItemId: local(unit.learningItemId) })),
    new_item_ids: row.new_item_ids.map(local),
    review_item_ids: row.review_item_ids.map(local),
  };
}

/** 只給測試使用：清空某個使用者的別名／journal，避免測試之間互相汙染。 */
export function __clearAliasStoreForTests(userId: string): void {
  const storage = browserStorage();
  storage.removeItem(`${ALIAS_KEY_PREFIX}${userId}`);
  storage.removeItem(`${JOURNAL_KEY_PREFIX}${userId}`);
}
