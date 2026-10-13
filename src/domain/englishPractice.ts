import type { LearningItem, ReviewAttempt, StudySession, ScheduleState } from "./types";

export interface EnglishVariant {
  id: string;
  mode: "direct" | "context";
  sentence?: string;
  targetText: string;
  translationZh?: string;
  choices: { id: string; text: string }[];
  correctChoiceId: string;
  explanationZh: string;
  hint?: string;
  role: "practice" | "verification";
}
export interface EnglishPractice {
  version: 1;
  senseKey: string;
  variants: EnglishVariant[];
  /** Selected only in immutable session/evidence snapshots. */
  activeVariantId?: string;
}
const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const text = (v: unknown, max = 2000): v is string => typeof v === "string" && v.trim().length > 0 && v.length <= max;
const allowed = (v: Record<string, unknown>, keys: string[]) => Object.keys(v).every(k => keys.includes(k));
export function isEnglishPractice(value: unknown): value is EnglishPractice {
  if (!record(value) || !allowed(value, ["version", "senseKey", "variants", "activeVariantId"]) || value.version !== 1 || !text(value.senseKey, 160) || !Array.isArray(value.variants) || value.variants.length < 3 || value.variants.length > 30) return false;
  const variants = value.variants;
  if (!variants.every(v => {
    if (!record(v) || !allowed(v, ["id", "mode", "sentence", "targetText", "translationZh", "choices", "correctChoiceId", "explanationZh", "hint", "role"]) || !text(v.id, 160) || !["direct", "context"].includes(String(v.mode)) || !["practice", "verification"].includes(String(v.role)) || !text(v.targetText, 160) || !text(v.explanationZh) || (v.hint !== undefined && !text(v.hint)) || !Array.isArray(v.choices) || v.choices.length !== 4) return false;
    if (v.mode === "context" && (!text(v.sentence) || !text(v.translationZh) || !v.sentence.toLowerCase().includes(v.targetText.toLowerCase()))) return false;
    if (v.mode === "direct" && (v.sentence !== undefined || v.translationZh !== undefined || v.role !== "practice")) return false;
    return v.choices.every(c => record(c) && allowed(c, ["id", "text"]) && text(c.id, 80) && text(c.text, 160)) &&
      new Set(v.choices.map(c => c.id)).size === 4 && new Set(v.choices.map(c => c.text.trim().normalize("NFKC"))).size === 4 && v.choices.some(c => c.id === v.correctChoiceId);
  })) return false;
  return new Set(variants.map(v => v.id)).size === variants.length && new Set(variants.map(englishQuestionKey)).size === variants.length && variants.some(v => v.mode === "direct") && variants.some(v => v.mode === "context" && v.role === "practice") && variants.some(v => v.role === "verification") &&
    (value.activeVariantId === undefined || variants.some(v => v.id === value.activeVariantId));
}
export function activeEnglishVariant(item: Pick<LearningItem, "englishPractice">): EnglishVariant | undefined {
  return item.englishPractice?.variants.find(v => v.id === item.englishPractice?.activeVariantId);
}
/** Semantic content fingerprint: renaming a variant does not make its question new. */
export function englishQuestionKey(v: EnglishVariant): string {
  const normalize = (text: string) => text.normalize("NFKC").trim().replace(/\s+/g," ").toLowerCase();
  return JSON.stringify([v.mode, normalize(v.sentence ?? ""), normalize(v.targetText), v.choices.map(c => normalize(c.text)).sort(), normalize(v.choices.find(c => c.id === v.correctChoiceId)?.text ?? "")]);
}
export function sameEnglishContent(a: LearningItem, b: LearningItem): boolean {
  const normalize = (i: LearningItem) => i.englishPractice && JSON.stringify([i.answer, i.promptZh, i.partOfSpeech, i.englishPractice.senseKey, i.englishPractice.variants.map(englishQuestionKey)]);
  return normalize(a) === normalize(b);
}
export function englishEvidence(item: LearningItem, attempts: ReviewAttempt[], mode?: EnglishVariant["mode"]) {
  const history = attempts.filter(a => a.learningItemId === item.id && a.language === "en" && a.exerciseType === "meaning" && a.abilityEvidence?.attemptNumber === 0 && sameEnglishContent(item, a.abilityEvidence.question) && (!mode || activeEnglishVariant(a.abilityEvidence.question)?.mode === mode))
    .sort((a, b) => a.reviewedAt.localeCompare(b.reviewedAt) || a.id.localeCompare(b.id));
  let successes: ReviewAttempt[] = [];
  for (const a of history) {
    if (a.result !== "correct" || a.usedHint) successes = [];
    else if (a.abilityEvidence?.wasDue && !successes.some(s => s.abilityEvidence?.day === a.abilityEvidence?.day)) successes.push(a);
  }
  return successes;
}
export function englishModeVerified(item: LearningItem, attempts: ReviewAttempt[], mode: EnglishVariant["mode"]): boolean {
  const successes = englishEvidence(item, attempts, mode);
  const contexts = new Set(successes.map(a => activeEnglishVariant(a.abilityEvidence!.question)).filter((v): v is EnglishVariant => !!v).map(englishQuestionKey));
  return successes.length >= 2 && (mode !== "context" || contexts.size >= 2) && Date.parse(successes.at(-1)!.reviewedAt) - Date.parse(successes.at(-2)!.reviewedAt) >= 7 * 86_400_000;
}
export function englishStatus(item: LearningItem, schedules: ScheduleState[], attempts: ReviewAttempt[]) {
  const schedule = schedules.find(s => s.learningItemId === item.id && s.ability === "meaning");
  if (!schedule) return "new" as const;
  if (item.needsUnderstanding) return "learning" as const;
  if ((schedule.recentFailures ?? 0) >= 3) return "struggling" as const;
  if (schedule.reviewPolicy === 1 && !schedule.reviewCompleted) return "learning" as const;
  return englishModeVerified(item, attempts, "direct") && englishModeVerified(item, attempts, "context") ? "mastered" as const : "learning" as const;
}
export function freezeEnglishQuestion(item: LearningItem, attempts: ReviewAttempt[], sessions: StudySession[], verifying: boolean): LearningItem {
  if (!item.englishPractice) return structuredClone(item);
  const history = attempts.filter(a => a.learningItemId === item.id && a.abilityEvidence?.attemptNumber === 0 && sameEnglishContent(item, a.abilityEvidence.question)).sort((a,b) => a.reviewedAt.localeCompare(b.reviewedAt) || a.id.localeCompare(b.id));
  const seen = [...history.map(a => a.abilityEvidence!.question), ...sessions.flatMap(s => s.plannedUnits.map(u => u.itemSnapshot)).filter((q): q is LearningItem => !!q && q.id === item.id && sameEnglishContent(item, q))];
  const keys = new Set(seen.map(activeEnglishVariant).filter((v): v is EnglishVariant => !!v).map(englishQuestionKey));
  const introducedExample = item.englishPractice.variants.find(v => v.mode === "context" && v.role === "practice");
  if (item.introducedAt && introducedExample) keys.add(englishQuestionKey(introducedExample));
  const last = activeEnglishVariant(history.at(-1)?.abilityEvidence?.question ?? item);
  // Alternate modes so direct recognition cannot starve behind a large context pool.
  const nextMode = last?.mode === "direct" ? "context" : "direct";
  const pool = item.englishPractice.variants.filter(v => verifying || v.role === "practice");
  const preferred = pool.filter(v => v.mode === nextMode);
  const candidates = [...preferred, ...pool.filter(v => v.mode !== nextMode)];
  const variant = verifying
    ? candidates.find(v => !keys.has(englishQuestionKey(v))) ?? candidates.find(v => v.id !== last?.id) ?? candidates[0]
    : preferred.find(v => !keys.has(englishQuestionKey(v))) ?? preferred[0] ?? candidates[0];
  const frozen = { ...structuredClone(item), englishPractice: { ...structuredClone(item.englishPractice), activeVariantId: variant.id } };
  if (verifying) frozen.verificationQuestion = { key: `en:${item.id}:${variant.id}`, kind: variant.mode === "context" ? "context" : "retention", novel: !keys.has(englishQuestionKey(variant)), basePrompt: item.promptZh };
  return frozen;
}
