import { isLearningItem, isReviewAttempt, isScheduleState, isDailyPlan, type PersistedStore } from "./schema";
import { rowToLearningItem, rowToReviewAttempt, rowToScheduleState, type OutboxEntry, type LearningItemRow, type ReviewAttemptRow, type ScheduleStateRow } from "./sync/outbox";

const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const text = (v: unknown): v is string => typeof v === "string" && v.length > 0;
const integer = (v: unknown) => Number.isSafeInteger(v) && Number(v) >= 0;
const date = (v: unknown) => text(v) && Number.isFinite(Date.parse(v));
const schedule = (v: unknown, last = true): boolean => record(v) && date(v.due_at) && integer(v.interval_days) && Number(v.interval_days) > 0 && integer(v.streak) && integer(v.lapse_count) && (!last || v.last_reviewed_at === null || date(v.last_reviewed_at));

/** Validate the payload, not just the outbox envelope, before restoring a queue. */
export function validateBackupOperation(entry: OutboxEntry, store: PersistedStore): void {
  const p = entry.payload as unknown as Record<string, unknown>;
  const item = (id: unknown) => store.items.find(i => i.id === id);
  const session = (id: unknown) => store.studySessions.find(s => s.id === id);
  let valid = true;
  if (entry.type === "learning_event") {
    const event = entry.payload;
    valid = text(event.id) && ["plan", "introduction", "hint", "attempt", "correction", "edit", "skip"].includes(event.kind) &&
      (!event.plan || (isDailyPlan(event.plan) && event.plan.newItemIds.every(id => !!item(id)) && event.plan.units.every(unit => !!item(unit.learningItemId)))) &&
      (event.kind === "plan" ? !!event.plan : event.kind === "edit" ? !!event.item && !!event.beforeItem && event.item.id === event.beforeItem.id && !!event.beforeSchedules && !!event.schedules && event.beforeSchedules.every(row => isScheduleState(rowToScheduleState(row))) && event.schedules.every(row => isScheduleState(rowToScheduleState(row))) : !!event.session && !!event.beforeSession && !!session(event.session.id) && event.session.id === event.beforeSession.id) &&
      (!event.item || (isLearningItem(rowToLearningItem(event.item)) && !!item(event.item.id))) &&
      (!event.attempt || (isReviewAttempt(rowToReviewAttempt(event.attempt)) && event.attempt.session_id === event.session?.id && !!item(event.attempt.learning_item_id))) &&
      (!event.schedule || isScheduleState(rowToScheduleState(event.schedule))) && (!event.beforeSchedule || isScheduleState(rowToScheduleState(event.beforeSchedule)));
  } else if (entry.type === "upsert_item") {
    valid = isLearningItem(rowToLearningItem(p as unknown as LearningItemRow)) && !!item(p.id);
  } else if (entry.type === "upsert_schedule_state") {
    const s = rowToScheduleState(p as unknown as ScheduleStateRow);
    valid = isScheduleState(s) && item(s.learningItemId)?.language === s.language;
  } else if (entry.type === "upsert_review_attempt") {
    const a = rowToReviewAttempt(p as unknown as ReviewAttemptRow);
    const s = session(a.sessionId);
    const unit = s?.plannedUnits[Number(p.sequence_in_session)];
    valid = isReviewAttempt(a) && integer(p.sequence_in_session) && !!unit && unit.learningItemId === a.learningItemId && unit.ability === a.exerciseType && item(a.learningItemId)?.language === a.language && s?.language === a.language;
  } else if (entry.type === "upsert_session") {
    valid = !!session(p.id) && ["in_progress", "completed", "abandoned"].includes(String(p.status)) && ["ja", "en"].includes(String(p.language)) && date(p.started_at) &&
      (p.status === "completed" ? date(p.completed_at) : p.completed_at === null) &&
      Array.isArray(p.planned_units) && p.planned_units.length > 0 && p.planned_units.every(u => record(u) && item(u.learningItemId)?.language === p.language && ["recall", "reading", "meaning"].includes(String(u.ability)) && ["new", "review"].includes(String(u.kind))) &&
      [p.new_item_ids, p.review_item_ids].every(ids => Array.isArray(ids) && ids.every(id => item(id)?.language === p.language));
  } else if (entry.type === "record_graded_attempt") {
    const s = session(p.session_id);
    valid = !!s && !!item(p.learning_item_id) && date(p.reviewed_at) && text(p.attempt_id) && text(p.exercise_id) &&
      ["recall", "reading", "meaning"].includes(String(p.ability)) && p.exercise_type === p.ability &&
      ["correct", "partial", "incorrect"].includes(String(p.result)) && typeof p.used_hint === "boolean" && integer(p.response_time_ms) &&
      (p.expected_schedule === null || schedule(p.expected_schedule)) && schedule(p.schedule, false) &&
      ["new", "learning", "mastered", "struggling"].includes(String(p.item_status)) && typeof p.session_completed === "boolean" &&
      (p.session_completed ? date(p.session_completed_at) : p.session_completed_at === null) &&
      s.plannedUnits.some(u => u.learningItemId === p.learning_item_id && u.ability === p.ability);
  } else if (entry.type === "mark_attempt_correct") {
    valid = !!session(p.session_id) && store.reviewAttempts.some(a => a.sessionId === p.session_id && a.exerciseId === p.exercise_id) && schedule(p.expected_schedule) && schedule(p.schedule, false) && ["new", "learning", "mastered", "struggling"].includes(String(p.item_status));
  } else if (entry.type === "abandon_session") {
    valid = !!session(p.sessionId);
  } else if (entry.type === "archive_items" || entry.type === "delete_items") {
    valid = Array.isArray(p.ids) && p.ids.length > 0 && p.ids.every(id => text(id)) && (entry.type !== "archive_items" || date(p.archivedAt));
  } else if (entry.type === "upsert_preferences") {
    valid = [5, 10, 15, 20].includes(Number(p.daily_question_count)) && [0, 5, 10, 15, 20, 30].includes(Number(p.daily_new_item_cap));
  }
  if (!valid) throw new Error(`備份 ${entry.type} 待送操作的欄位或關聯不完整，已拒絕還原。`);
}
