import type { SupabaseClient } from "@supabase/supabase-js";
import { canonicalJson } from "../../domain/learningPractice";
import { fetchAllRows } from "../../lib/supabase/pagination";
import { fetchStableSnapshot } from "../../lib/supabase/snapshot";
import { accountStorage, getAccountGeneration, getAccountOwner } from "../accountStorage";
import { readPersistedStore, sanitizeStore, writePersistedStore, type PersistedStore } from "../schema";
import { loadAliasStore, translateIncomingAttempt, translateIncomingSession } from "./alias";
import { listOutboxEntries, rowToReviewAttempt, rowToStudySessionShell, setOutboxEntries, studySessionToRow,
  type OutboxEntry, type StudySessionRow, type ReviewAttemptRow } from "./outbox";

const same = (a: unknown, b: unknown) => canonicalJson(a) === canonicalJson(b);
export class LearningQuestionRecoveryRefused extends Error {}
function requireEvidence(condition: unknown): asserts condition {
  if (!condition) throw new LearningQuestionRecoveryRefused("題目位置衝突無法安全恢復；原作答與待送紀錄均已保留。");
}
const resultOf = (row: ReviewAttemptRow) => ({ exerciseId: row.exercise_id, learningItemId: row.learning_item_id,
  exerciseType: row.exercise_type, result: row.result, usedHint: row.used_hint, responseTimeMs: row.response_time_ms,
  ...(row.learning_metadata ? { attemptNumber: row.learning_metadata.attemptNumber } : {}) });

/** Narrow recovery: a completed local branch reanswered exactly one cloud-committed position.
 * Keep both actual answers. Fork the unsent suffix rather than overwriting the cloud prefix.
 * This function is pure; production must first fetch a stable authenticated cloud snapshot.
 */
export function buildLearningQuestionRecovery(store: PersistedStore, pending: OutboxEntry[], owner: string,
  remote: StudySessionRow, remoteAnswers: ReviewAttemptRow[]) {
  const head = pending[0];
  requireEvidence(head?.type === "learning_event" && head.payload.kind === "attempt");
  const event = head.payload, answer = event.attempt, before = event.beforeSession;
  requireEvidence(answer && before && event.session && answer.learning_metadata?.ruleVersion === 2);
  const offset = answer.sequence_in_session;
  requireEvidence(Number.isSafeInteger(offset) && offset >= 1 && answer.learning_metadata.attemptNumber === 0);
  const originalId = before.id;
  const local = store.studySessions.find(session => session.id === originalId);
  requireEvidence(local?.status === "completed" && local.ruleVersion === 2 && before.status === "in_progress");
  requireEvidence(remote.user_id === owner && before.user_id === owner && remote.id === originalId &&
    remote.status === "in_progress" && same(rowToStudySessionShell(remote), rowToStudySessionShell(before)));
  const committed = [...remoteAnswers].sort((a, b) => a.sequence_in_session - b.sequence_in_session);
  requireEvidence(committed.length === offset + 1 && committed.every((row, index) => row.user_id === owner &&
    row.session_id === originalId && row.sequence_in_session === index));
  // The extra cloud answer must be a real, locally retained answer to the exact frozen question.
  const occupied = committed[offset];
  const unit = before.planned_units[offset];
  requireEvidence(unit && unit.learningItemId === answer.learning_item_id && unit.ability === answer.exercise_type &&
    same(unit.itemSnapshot, answer.learning_metadata.question) &&
    occupied.learning_item_id === answer.learning_item_id && occupied.exercise_type === answer.exercise_type &&
    occupied.exercise_id !== answer.exercise_id && occupied.learning_metadata?.attemptNumber === 0 &&
    same(occupied.learning_metadata.question, answer.learning_metadata.question) &&
    Date.parse(occupied.reviewed_at) < Date.parse(answer.reviewed_at));
  requireEvidence(committed.every((row, index) => {
    const saved = store.reviewAttempts.find(attempt => attempt.id === row.id);
    return saved && same(saved, rowToReviewAttempt(row)) && (index === offset || same(local.exerciseResults[index], resultOf(row)));
  }));

  const branch: (OutboxEntry & { type: "learning_event" })[] = [];
  for (const entry of pending) {
    if (entry.type !== "learning_event" || entry.payload.kind !== "attempt" || entry.payload.beforeSession?.id !== originalId) break;
    branch.push(entry);
  }
  requireEvidence(branch.length > 0 && branch.length + offset === local.exerciseResults.length);
  requireEvidence(!pending.slice(branch.length).some(entry =>
    entry.type === "upsert_session" ? entry.payload.id === originalId :
    entry.type === "abandon_session" ? entry.payload.sessionId === originalId :
    "session_id" in entry.payload ? entry.payload.session_id === originalId :
    entry.type === "learning_event" && entry.payload.session?.id === originalId));
  branch.forEach((entry, index) => {
    const p = entry.payload, a = p.attempt, position = offset + index;
    requireEvidence(a && p.beforeSession && p.session && a.user_id === owner && p.beforeSession.user_id === owner &&
      p.session.user_id === owner && a.session_id === originalId && p.session.id === originalId &&
      a.sequence_in_session === position && same(resultOf(a), local.exerciseResults[position]) &&
      same(rowToReviewAttempt(a), store.reviewAttempts.find(saved => saved.id === a.id)) &&
      same(p.beforeSession.planned_units.slice(0, offset), before.planned_units.slice(0, offset)) &&
      same(p.session.planned_units.slice(0, offset), before.planned_units.slice(0, offset)) &&
      !committed.some(row => row.id === a.id || row.exercise_id === a.exercise_id));
    if (index) requireEvidence(same(branch[index - 1].payload.session, p.beforeSession));
  });
  requireEvidence(same(rowToStudySessionShell(branch.at(-1)!.payload.session!), rowToStudySessionShell(studySessionToRow(local, owner))));
  const knownIds = new Set([...committed.map(row => row.id), ...branch.map(entry => entry.payload.attempt!.id)]);
  requireEvidence(store.reviewAttempts.filter(a => a.sessionId === originalId).every(a => knownIds.has(a.id)));

  const recoveredId = `session_recovery_${event.id}`;
  requireEvidence(!store.studySessions.some(s => s.id === recoveredId));
  const shiftSession = (row: StudySessionRow): StudySessionRow => ({ ...structuredClone(row), id: recoveredId,
    planned_units: structuredClone(row.planned_units.slice(offset)),
    learning_metadata: { ...structuredClone(row.learning_metadata),
      hintedIndices: row.learning_metadata?.hintedIndices?.filter(index => index >= offset).map(index => index - offset) },
  });
  const shifted = branch.map(entry => ({ ...structuredClone(entry), payload: { ...structuredClone(entry.payload),
    beforeSession: shiftSession(entry.payload.beforeSession!), session: shiftSession(entry.payload.session!),
    attempt: { ...structuredClone(entry.payload.attempt!), session_id: recoveredId,
      sequence_in_session: entry.payload.attempt!.sequence_in_session - offset },
  } }));
  const next = structuredClone(store);
  const movedIds = new Set(branch.map(entry => entry.payload.attempt!.id));
  next.reviewAttempts = next.reviewAttempts.map(attempt => movedIds.has(attempt.id) ? { ...attempt, sessionId: recoveredId } : attempt);
  next.studySessions = next.studySessions.map(session => session.id === originalId
    ? { ...rowToStudySessionShell(remote), status: "abandoned", exerciseResults: committed.map(resultOf) } : session);
  next.studySessions.push({ ...rowToStudySessionShell(shiftSession(studySessionToRow(local, owner))),
    exerciseResults: structuredClone(local.exerciseResults.slice(offset)) });
  requireEvidence(!sanitizeStore(next).usedFallback);
  const entries: OutboxEntry[] = [
    { ...head, id: `${head.id}:recovery-session`, type: "upsert_session", attempts: 0, lastError: undefined,
      payload: shiftSession(before) },
    ...shifted, // Every original event remains queued, with its original event and attempt ID.
    { ...head, id: `${head.id}:close-original`, type: "abandon_session", attempts: 0, lastError: undefined,
      payload: { sessionId: originalId } },
    ...structuredClone(pending.slice(branch.length)),
  ];
  const journal = { entryId: head.id, at: new Date().toISOString(), original: structuredClone(event), rebased: shifted[0].payload,
    recovery: { originalSession: structuredClone(local), remoteSession: structuredClone(remote),
      remoteAttempts: structuredClone(committed), entryIds: branch.map(entry => entry.id), offset } };
  return { store: next, entries, journal };
}

/** Called inside the account data lock only after a confirmed RPC transaction rejection. */
export async function recoverLearningQuestion(client: SupabaseClient, owner: string, entry: OutboxEntry & { type: "learning_event" }) {
  const generation = getAccountGeneration(), aliases = loadAliasStore(owner);
  const sessionId = entry.payload.beforeSession?.id;
  requireEvidence(sessionId);
  const [sessions, answers] = await fetchStableSnapshot(client, () => Promise.all([
    fetchAllRows<StudySessionRow>((from, to) => client.from("study_sessions").select("*").eq("user_id", owner).eq("id", sessionId).order("id").range(from, to)),
    fetchAllRows<ReviewAttemptRow>((from, to) => client.from("review_attempts").select("*").eq("user_id", owner).eq("session_id", sessionId).order("sequence_in_session").range(from, to)),
  ]));
  requireEvidence(getAccountOwner() === owner && generation === getAccountGeneration() && sessions.length === 1);
  const pending = listOutboxEntries();
  requireEvidence(pending[0]?.id === entry.id && same(pending[0], entry));
  const recovery = buildLearningQuestionRecovery(readPersistedStore(), pending, owner,
    translateIncomingSession(sessions[0], aliases), answers.map(row => translateIncomingAttempt(row, aliases)));
  const key = `learning-language:sync-learning-rebase:${owner}`;
  const journal: unknown = JSON.parse(accountStorage().getItem(key) ?? "[]");
  requireEvidence(Array.isArray(journal));
  // withDataLock commits the journal, store and queue in the same durable account snapshot.
  accountStorage().setItem(key, JSON.stringify([...journal, recovery.journal]));
  writePersistedStore(recovery.store);
  setOutboxEntries(recovery.entries);
}
