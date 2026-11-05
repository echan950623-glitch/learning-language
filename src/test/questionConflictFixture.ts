import { MemoryLearningRepository } from "../repository/memoryRepository";
import { createEmptyStore, type PersistedStore } from "../repository/schema";
import { reviewAttemptToRow, scheduleStateToRow, studySessionToRow, learningItemToRow, type OutboxEntry, type LearningEventPayload } from "../repository/sync/outbox";
const OWNER = "00000000-0000-0000-0000-000000000001";

export function questionConflictFixture() {
  const seed = new MemoryLearningRepository();
  const now = new Date("2026-11-03T14:32:00Z");
  const items = Array.from({ length: 7 }, (_, index) => ({ ...seed.addItem({ language: "ja", type: "vocabulary", promptZh: `字${index}`, answer: `語${index}`, reading: `ご${index}`, source: "manual", tags: [] }), introducedAt: "2026-11-02T00:00:00Z" }));
  let repo = new MemoryLearningRepository({ ...createEmptyStore(), items });
  let session = repo.getOrCreateInProgressSession("ja", items.map(item => ({ learningItemId: item.id, ability: "reading", kind: "review" })), now, { mode: "full" });
  const snapshot = (): PersistedStore => ({ ...createEmptyStore(), items: repo.listItems(), scheduleStates: repo.listScheduleStates(), reviewAttempts: repo.listReviewAttempts(), studySessions: repo.listStudySessions({ status: "all" }) });
  let clock = now.getTime();
  const answer = (hint = false) => {
    const index = session.exerciseResults.length, unit = session.plannedUnits[index];
    clock += 10_000;
    const result = repo.recordGradedAttempt({ sessionId: session.id, learningItemId: unit.learningItemId, ability: unit.ability,
      exerciseId: `exercise_${clock}`, exerciseType: "reading", result: "correct", usedHint: hint, responseTimeMs: 100,
      now: new Date(clock), rawAnswer: unit.itemSnapshot!.reading, normalizedAnswer: unit.itemSnapshot!.reading });
    session = result.session;
    return result;
  };
  const first = answer(), second = answer();
  const remote = studySessionToRow(session, OWNER);
  const remoteAnswers = [reviewAttemptToRow(first.attempt, 0, OWNER), reviewAttemptToRow(second.attempt, 1, OWNER)];
  const remoteStore = snapshot();
  // Reproduce the download/drain race: real second answer remains, cursor rolls back by one.
  const stale = snapshot();
  stale.studySessions[0].exerciseResults = stale.studySessions[0].exerciseResults.slice(0, 1);
  repo = new MemoryLearningRepository(stale);
  session = repo.listStudySessions({ status: "all" })[0];
  const entries: OutboxEntry[] = [];
  while (session.status === "in_progress") {
    const before = studySessionToRow(session, OWNER), index = session.exerciseResults.length;
    const unit = session.plannedUnits[index], previous = repo.getScheduleState(unit.learningItemId, unit.ability);
    const result = answer(entries.length === 0);
    const p: LearningEventPayload = { id: `event_${index}`, kind: "attempt", beforeSession: before, session: studySessionToRow(session, OWNER),
      attempt: reviewAttemptToRow(result.attempt, index, OWNER), item: learningItemToRow(repo.getItem(unit.learningItemId)!, OWNER),
      beforeSchedule: entries.length === 0 ? null : previous ? scheduleStateToRow(previous, OWNER) : null,
      schedule: scheduleStateToRow(repo.getScheduleState(unit.learningItemId, unit.ability)!, OWNER) };
    entries.push({ id: `outbox_${index}`, type: "learning_event", payload: p, createdAt: new Date(clock).toISOString(), attempts: index === 1 ? 61 : 0 });
  }
  return { store: snapshot(), entries, owner: OWNER, remote, remoteAnswers, remoteStore };
}
