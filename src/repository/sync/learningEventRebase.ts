import type { SupabaseClient } from "@supabase/supabase-js";
import { replayLearningEvidence } from "../../domain/replayLearningEvidence";
import { combineAbilityStatuses } from "../../domain/srs";
import { requiredAbilities } from "../../domain/abilities";
import { evidenceStatus } from "../../domain/learningRules";
import { accountStorage, getAccountGeneration, getAccountOwner } from "../accountStorage";
import { readPersistedStore, writePersistedStore, sanitizeStore } from "../schema";
import { fetchAllRows } from "../../lib/supabase/pagination";
import { fetchStableSnapshot } from "../../lib/supabase/snapshot";
import { loadAliasStore, resolveCanonicalItemId, translateIncomingItem, translateIncomingAttempt, translateIncomingSchedule } from "./alias";
import { learningItemToRow, listOutboxEntries, rowToLearningItem, rowToReviewAttempt, rowToScheduleState, scheduleStateToRow, setOutboxEntries,
  type LearningItemRow, type ReviewAttemptRow, type ScheduleStateRow, type OutboxEntry } from "./outbox";

/** Called under the account data lock after a confirmed transaction rejection. No event is dropped. */
export async function rebaseLearningEvent(client: SupabaseClient, owner: string, entry: OutboxEntry & { type: "learning_event" }): Promise<void> {
  const event = entry.payload;
  if (!event.attempt || !["attempt","correction"].includes(event.kind)) throw new Error("這項內容變更需要人工核對，原待送事件已保留。");
  const generation = getAccountGeneration();
  const aliases = loadAliasStore(owner);
  const localId = event.attempt.learning_item_id;
  const canonicalId = resolveCanonicalItemId(aliases, localId);
  const [items, schedules, attempts] = await fetchStableSnapshot(client, () => Promise.all([
    fetchAllRows<LearningItemRow>((from,to) => client.from("learning_items").select("*").eq("user_id",owner).eq("id",canonicalId).order("id").range(from,to)),
    fetchAllRows<ScheduleStateRow>((from,to) => client.from("schedule_states").select("*").eq("user_id",owner).eq("learning_item_id",canonicalId).order("ability").range(from,to)),
    fetchAllRows<ReviewAttemptRow>((from,to) => client.from("review_attempts").select("*").eq("user_id",owner).eq("learning_item_id",canonicalId).eq("exercise_type",event.attempt!.exercise_type).order("id").range(from,to)),
  ]));
  if (getAccountOwner() !== owner || generation !== getAccountGeneration()) throw new Error("帳戶已切換，舊同步回應未寫入。");
  if (items.length !== 1) throw new Error("雲端單字歸屬無法確認，原事件已保留。");
  const item = rowToLearningItem(translateIncomingItem(items[0],aliases));
  const remoteSchedules = schedules.map(row => rowToScheduleState(translateIncomingSchedule(row,aliases)));
  const ability = event.attempt.exercise_type === "meaning" ? "meaning" : event.attempt.exercise_type === "reading" ? "reading" : "recall";
  const before = remoteSchedules.find(schedule => schedule.ability === ability);
  const remoteAttempts = attempts.map(row => rowToReviewAttempt(translateIncomingAttempt(row,aliases)));
  const pendingAttempt = rowToReviewAttempt(event.attempt);
  const allAttempts = [...remoteAttempts.filter(attempt => !(attempt.sessionId === pendingAttempt.sessionId && attempt.exerciseId === pendingAttempt.exerciseId)),pendingAttempt];
  const rebased = replayLearningEvidence(item,allAttempts,before);
  const otherStatuses = requiredAbilities({ ...item, reviewPaused: false }).map(kind => evidenceStatus(kind === ability ? rebased : remoteSchedules.find(schedule => schedule.ability === kind)));
  item.status = combineAbilityStatuses(otherStatuses);
  const nextEvent = { ...structuredClone(event), beforeSchedule: before ? scheduleStateToRow(before,owner) : null,
    schedule: rebased ? scheduleStateToRow(rebased,owner) : null, item: learningItemToRow(item,owner), replayAttemptIds: attempts.map(attempt => attempt.id).sort() };
  const journalKey = `learning-language:sync-learning-rebase:${owner}`;
  const journal = JSON.parse(accountStorage().getItem(journalKey) ?? "[]") as unknown[];
  if (!Array.isArray(journal)) throw new Error("學習事件恢復紀錄不完整，已停止同步。");
  if (JSON.stringify(nextEvent) === JSON.stringify(event)) throw new Error("雲端排程持續衝突，原事件保留，請重新下載後核對。");
  accountStorage().setItem(journalKey,JSON.stringify([...journal,{entryId:entry.id,at:new Date().toISOString(),original:event,rebased:nextEvent}]));
  const current = readPersistedStore();
  const pending = listOutboxEntries();
  if (pending.some(candidate => candidate.type === "learning_event" && candidate.payload.kind === "edit" && candidate.payload.item?.id === localId))
    throw new Error("此單字仍有本機編輯待送，不能用遠端內容覆蓋；兩份資料均已保留。");
  const itemIndex = current.items.findIndex(candidate => candidate.id === localId);
  if (itemIndex < 0) throw new Error("本機單字關聯不完整，原事件已保留。");
  current.items[itemIndex] = item;
  const pendingAnswers = pending.flatMap(candidate => candidate.type === "learning_event" && candidate.payload.attempt?.learning_item_id === localId && candidate.payload.attempt.exercise_type === ability ? [rowToReviewAttempt(candidate.payload.attempt)] : []);
  const displayAttempts = new Map([...remoteAttempts,...pendingAnswers].map(attempt => [`${attempt.sessionId}:${attempt.exerciseId}`,attempt]));
  const display = replayLearningEvidence(item,[...displayAttempts.values()],rebased);
  const scheduleIndex = current.scheduleStates.findIndex(schedule => schedule.learningItemId === localId && schedule.ability === ability);
  if (display) { if (scheduleIndex < 0) current.scheduleStates.push(display); else current.scheduleStates[scheduleIndex] = display; }
  if (sanitizeStore(current).usedFallback) throw new Error("恢復後的紀錄關聯不完整；原資料保留。");
  writePersistedStore(current);
  setOutboxEntries(pending.map(candidate => candidate.id === entry.id ? { ...entry,payload:nextEvent } : candidate));
}
