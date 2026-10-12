import { isLearningItem, type PersistedStore } from "./schema";
import { rowToLearningItem, type LearningItemRow } from "./sync/outbox";

const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const text = (value: unknown): value is string => typeof value === "string" && value.length > 0;
const date = (value: unknown): boolean => text(value) && Number.isFinite(Date.parse(value));
const schedule = (value: unknown): boolean => record(value) && date(value.due_at) && Number.isSafeInteger(value.interval_days) && Number(value.interval_days)>0 && Number.isSafeInteger(value.streak) && Number(value.streak)>=0 && Number.isSafeInteger(value.lapse_count) && Number(value.lapse_count)>=0 && (value.last_reviewed_at === null || date(value.last_reviewed_at));

/** Recovery evidence is executable sync input, so malformed journals must fail before restore. */
export function validateRecoveryValues(values: Record<string,string>, owner: string|null, store: PersistedStore): void {
  const sessions=new Set(store.studySessions.map(session=>session.id));
  for(const [key,raw] of Object.entries(values)) {
    if(!/^learning-language:sync-(alias(?:-journal)?|rebase-journal):/.test(key)) continue;
    if(!owner || !key.endsWith(`:${owner}`)) throw new Error("同步恢復紀錄的帳戶歸屬不符。");
    const parsed: unknown=JSON.parse(raw);
    if(key.startsWith("learning-language:sync-alias:")) {
      if(!record(parsed) || !Array.isArray(parsed.items) || !Array.isArray(parsed.attempts) || !Array.isArray(parsed.conflicts)) throw new Error("別名快照格式不完整。");
      if(parsed.items.some(entry=>!record(entry)||!text(entry.localId)||!text(entry.canonicalId)) || parsed.attempts.some(entry=>!record(entry)||!text(entry.sessionId)||!text(entry.exerciseId)||!text(entry.canonicalAttemptId))) throw new Error("別名快照欄位不完整。");
      continue; // The authoritative journal is checked below; this cache is rebuilt from it.
    }
    if(!Array.isArray(parsed)) throw new Error("同步 journal 格式不完整。");
    for(const entry of parsed) {
      if(!record(entry)||!text(entry.id)||!date(entry.createdAt)) throw new Error("同步 journal 事件格式不完整。");
      if(key.startsWith("learning-language:sync-alias-journal:")) {
        if(entry.kind==="item_alias" && text(entry.localId) && text(entry.canonicalId)) continue;
        if(entry.kind==="attempt_alias" && text(entry.sessionId) && sessions.has(entry.sessionId) && text(entry.exerciseId) && text(entry.canonicalAttemptId)) continue;
        if(entry.kind==="item_conflict" && record(entry.conflict)) {
          const conflict=entry.conflict;
          if(!text(conflict.id)||!text(conflict.localId)||!text(conflict.canonicalId)||!date(conflict.createdAt)||!text(conflict.reason)||!text(conflict.detail)) throw new Error("別名衝突恢復紀錄不完整。");
          for(const row of [conflict.localSnapshot,conflict.remoteSnapshot]) if(!record(row)||row.user_id!==owner||!isLearningItem(rowToLearningItem(row as unknown as LearningItemRow))) throw new Error("別名衝突原始內容或帳戶不符。");
          continue;
        }
        throw new Error("別名 journal 事件不合法。");
      }
      if(!["record_graded_attempt","mark_attempt_correct"].includes(String(entry.kind)) || !text(entry.sessionId) || !sessions.has(entry.sessionId) || !text(entry.exerciseId) || !text(entry.outboxEntryId) || !text(entry.canonicalItemId) || !["recall","reading","meaning"].includes(String(entry.ability)) || !(entry.localExpected===null||schedule(entry.localExpected)) || ![entry.localAfter,entry.cloudBefore,entry.cloudAfter].every(schedule) || !record(entry.originalPayload) || entry.originalPayload.session_id!==entry.sessionId || entry.originalPayload.exercise_id!==entry.exerciseId) throw new Error("排程重放 journal 的證據或關聯不完整。");
    }
  }
}
