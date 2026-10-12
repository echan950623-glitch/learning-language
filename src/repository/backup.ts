import { accountKey, accountStorage, getAccountGeneration, invalidateAccountRequests, getAccountOwner, readAccountSnapshot, replaceAccountValues, withDataLock } from "./accountStorage";
import { createEmptyStore, sanitizeStore, STORAGE_KEY } from "./schema";
import { isOutboxEntry, type OutboxEntry } from "./sync/outbox";
import { validateBackupOperation } from "./backupValidation";
import { validateRecoveryValues } from "./backupRecoveryValidation";

const allowedKey = (key: string) => /^learning-language:(store(?::revision|:corrupt-backup|:pre-migration-backup:.+)?|sync-outbox|study-preferences(?::new-item-cap|:busy)?:v1|sync-alias(?:-journal)?:.+|sync-rebase-journal:.+|sync-learning-rebase:.+|migration-completed:.+|explicitly-claimed|sync-paused)$/.test(key);
interface Backup { format: "learning-language-backup"; version: 1; owner: string | null; exportedAt: string; values: Record<string, string> }
export interface BackupPreview { backup: Backup; generation: number; currentValues: string; summary: { items: number; attempts: number; sessions: number; pending: number } }
export function exportLocalBackup(): string {
  const snapshot = readAccountSnapshot();
  const values = Object.fromEntries(Object.entries(snapshot.values).filter(([key]) => allowedKey(key)));
  values[STORAGE_KEY] ??= JSON.stringify(createEmptyStore());
  return JSON.stringify({ format: "learning-language-backup", version: 1, owner: snapshot.owner, exportedAt: new Date().toISOString(), values } satisfies Backup, null, 2);
}
export function previewLatestRecoveryCopy(): BackupPreview {
  const prefix = `${accountKey()}:before-restore:`;
  const keys = Array.from({ length: window.localStorage.length }, (_, i) => window.localStorage.key(i))
    .filter((key): key is string => !!key && key.startsWith(prefix)).sort().reverse();
  if (!keys.length) throw new Error("此帳戶沒有還原前副本。");
  const snapshot = JSON.parse(window.localStorage.getItem(keys[0])!) as ReturnType<typeof readAccountSnapshot>;
  if (snapshot.format !== 1 || snapshot.owner !== getAccountOwner() || !snapshot.values) throw new Error("恢復副本格式或歸屬不符，原副本已保留。");
  return previewLocalBackup(JSON.stringify({ format: "learning-language-backup", version: 1, owner: snapshot.owner, exportedAt: new Date().toISOString(), values: Object.fromEntries(Object.entries(snapshot.values).filter(([key]) => allowedKey(key))) } satisfies Backup));
}
export function previewLocalBackup(text: string): BackupPreview {
  const data = JSON.parse(text) as Backup;
  if (data.format !== "learning-language-backup" || data.version !== 1 || data.owner !== getAccountOwner()) throw new Error("備份版本或帳戶歸屬不符；不能跨帳戶還原。");
  if (!data.values || typeof data.values !== "object" || Array.isArray(data.values) || !Object.entries(data.values).every(([key, value]) => allowedKey(key) && typeof value === "string")) throw new Error("備份含不允許的資料欄位。");
  if (!data.values[STORAGE_KEY]) throw new Error("備份沒有學習資料。");
  const result = sanitizeStore(JSON.parse(data.values[STORAGE_KEY]));
  if (result.usedFallback) throw new Error("備份紀錄或關聯不完整；已拒絕還原，不會丟棄問題紀錄。");
  validateRecoveryValues(data.values, data.owner, result.store);
  const pending = JSON.parse(data.values["learning-language:sync-outbox"] ?? "[]") as OutboxEntry[];
  const validateOwner = (value: unknown): void => {
    if (!value || typeof value !== "object") return;
    for (const [key, nested] of Object.entries(value)) {
      if ((key === "user_id" || key === "reservationOwner") && nested !== data.owner) throw new Error("備份包含其他帳戶的待送紀錄，已拒絕還原。");
      validateOwner(nested);
    }
  };
  validateOwner(pending);
  for (const [key, value] of Object.entries(data.values)) {
    if (key.startsWith("learning-language:sync-learning-rebase:")) {
      if (key !== `learning-language:sync-learning-rebase:${data.owner}`) throw new Error("恢復 journal 的帳戶不符。");
      const journal: unknown = JSON.parse(value);
      if (!Array.isArray(journal) || journal.some(entry => !entry || typeof entry !== "object" || typeof entry.entryId !== "string" || !Number.isFinite(Date.parse(entry.at)) || !entry.original || !entry.rebased || entry.original.id !== entry.rebased.id)) throw new Error("恢復 journal 格式不完整，已保留原資料。");
      validateOwner(journal);
      for (const entry of journal) for (const payload of [entry.original, entry.rebased]) validateBackupOperation({ id: entry.entryId, type: "learning_event", payload } as OutboxEntry, result.store);
    }
  }
  if (!Array.isArray(pending) || !pending.every(entry => isOutboxEntry(entry) && (data.owner === null || !('user_id' in entry.payload) || entry.payload.user_id === data.owner))) throw new Error("備份待送紀錄格式或歸屬不符。");
  for (const entry of pending) {
    validateBackupOperation(entry, result.store);
    const payload = entry.payload as unknown as Record<string, unknown>;
    const strings = (keys: string[]) => keys.every(key => typeof payload[key] === "string" && (payload[key] as string).length > 0);
    if (entry.type === "archive_items" || entry.type === "delete_items") {
      if (!Array.isArray(payload.ids) || !payload.ids.every(id => typeof id === "string") || (entry.type === "archive_items" && !Number.isFinite(Date.parse(String(payload.archivedAt))))) throw new Error("封存或刪除待送紀錄不合法。");
    } else if (entry.type === "record_graded_attempt") {
      if (!strings(["attempt_id", "session_id", "learning_item_id", "exercise_id", "reviewed_at"]) || !["recall", "reading"].includes(String(payload.ability)) || !["correct", "incorrect", "partial"].includes(String(payload.result)) || typeof payload.used_hint !== "boolean" || typeof payload.response_time_ms !== "number" || payload.response_time_ms < 0) throw new Error("作答待送紀錄不合法。");
    } else if (entry.type === "upsert_preferences") {
      if (![5,10,15,20].includes(Number(payload.daily_question_count)) || ![0,5,10,15,20,30].includes(Number(payload.daily_new_item_cap))) throw new Error("偏好待送紀錄不合法。");
    } else if (entry.type === "abandon_session") {
      if (!strings(["sessionId"])) throw new Error("session 待送紀錄不合法。");
    } else if (entry.type === "mark_attempt_correct") {
      if (!strings(["session_id", "exercise_id"])) throw new Error("更正待送紀錄不合法。");
    } else if (entry.type === "upsert_item" || entry.type === "upsert_session" || entry.type === "upsert_review_attempt") {
      if (!strings(["id", "user_id"])) throw new Error("匯入待送紀錄不合法。");
    } else if (entry.type === "upsert_schedule_state" && !strings(["learning_item_id", "user_id", "ability"])) throw new Error("排程待送紀錄不合法。");
  }
  const ids = new Set(result.store.items.map(item => item.id));
  const sessions = new Set(result.store.studySessions.map(session => session.id));
  if (result.store.dailyPlans?.some(plan => plan.newItemIds.some(id => !ids.has(id)) || plan.units.some(unit => !ids.has(unit.learningItemId)) || (plan.reservationOwner && plan.reservationOwner !== data.owner))) throw new Error("備份今日計畫的項目或帳戶關聯不完整。");
  if (result.store.studySessions.some(session => session.plannedUnits.some(unit => !ids.has(unit.learningItemId))) || result.store.reviewAttempts.some(attempt => !ids.has(attempt.learningItemId) || !sessions.has(attempt.sessionId))) throw new Error("備份包含無法追溯的項目或 session 關聯。");
  return { backup: structuredClone(data), generation: getAccountGeneration(), currentValues: JSON.stringify(readAccountSnapshot().values), summary: { items: ids.size, attempts: result.store.reviewAttempts.length, sessions: sessions.size, pending: pending.length } };
}
export async function restoreLocalBackup(preview: BackupPreview): Promise<void> {
  await withDataLock(() => {
    if (preview.generation !== getAccountGeneration()) throw new Error("帳戶或資料已更新，請重新預覽。");
    if (preview.currentValues !== JSON.stringify(readAccountSnapshot().values)) throw new Error("預覽後本機資料已更新，請重新預覽，避免覆蓋新的作答。");
    const validated = previewLocalBackup(JSON.stringify(preview.backup));
    // Recovery copy must succeed before replacing anything. No auth storage is included.
    window.localStorage.setItem(`${accountKey()}:before-restore:${Date.now()}`, JSON.stringify(readAccountSnapshot()));
    const deviceId = accountStorage().getItem("learning-language:device-id");
    replaceAccountValues({ ...validated.backup.values, ...(deviceId ? { "learning-language:device-id": deviceId } : {}), "learning-language:sync-paused": "true" });
  });
  invalidateAccountRequests();
}
export async function resumeBackupSync(): Promise<void> {
  await withDataLock(() => accountStorage().removeItem("learning-language:sync-paused"));
}
