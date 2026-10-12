import type { LearningRepository } from "./types";

/** Call inside mutateRepository: the item edit and current-round skip share one transaction. */
export function setVocabularyPaused(repository: LearningRepository, id: string, paused: boolean, now: Date) {
  const item = repository.getItem(id);
  if (!item || item.archivedAt || item.type !== "vocabulary" || item.practice || item.coachReport) {
    throw new Error("這個單字已變更，請重新載入。");
  }
  if (!!item.reviewPaused === paused) return item;
  return repository.editItem(id, item.contentVersion ?? 1, {
    promptZh: item.promptZh, answer: item.answer, reading: item.reading,
    explanation: item.explanation, partOfSpeech: item.partOfSpeech,
    exampleSentence: item.exampleSentence, acceptedAnswers: item.acceptedAnswers,
    answerFormat: item.answerFormat, reviewPaused: paused, autoVerificationRequestedAt: item.autoVerificationRequestedAt,
  }, now);
}

export function pauseVocabularyInSession(repository: LearningRepository, sessionId: string, index: number, id: string, now: Date) {
  // Validate the displayed question before changing the item's durable flag.
  const session = repository.skipVocabulary(sessionId, index, id, now);
  setVocabularyPaused(repository, id, true, now);
  return session;
}

/** A self-report requests a delayed check. It is never a correct attempt or mastery evidence. */
export function requestVocabularyVerification(repository: LearningRepository, sessionId: string, index: number, id: string, now: Date) {
  const session = repository.skipVocabulary(sessionId, index, id, now);
  const item = repository.getItem(id)!;
  if (item.reviewPaused) throw new Error("已暫停的內容不會自動恢復。");
  repository.editItem(id, item.contentVersion ?? 1, {
    promptZh: item.promptZh, answer: item.answer, reading: item.reading,
    explanation: item.explanation, partOfSpeech: item.partOfSpeech,
    exampleSentence: item.exampleSentence, acceptedAnswers: item.acceptedAnswers,
    answerFormat: item.answerFormat, reviewPaused: item.reviewPaused,
    autoVerificationRequestedAt: now.toISOString(),
  }, now);
  return session;
}
