import type { LearningItem, NewLearningItemInput, ReviewAttempt, ScheduleState, StudySessionPlannedUnit } from "./types";
import { evidenceStatus } from "./learningRules";
import { normalizeForComparison } from "./text";

export type PracticeKind = "conjugation" | "grammar" | "particle" | "structure" | "collocation" | "reading";
export type PracticeCapability = "recognition" | "production" | "usage";
export interface PracticeVariant {
  id: string;
  prompt: string;
  answer: string;
  acceptedAnswers: string[];
  explanation: string;
  hint?: string;
  stimulus?: string;
  contentKey?: string;
  errorCategory?: "form" | "attachment" | "particle" | "structure" | "meaning" | "vocabulary";
}
export interface LearningPractice {
  version: 1;
  kind: PracticeKind;
  conceptKey: string;
  title: string;
  capability: PracticeCapability;
  learned: boolean;
  enabled: boolean;
  formId?: string;
  variants: PracticeVariant[];
  /** Only a frozen question snapshot selects a variant. */
  activeVariantId?: string;
}
export interface CoachReport {
  version: 1;
  externalId: string;
  practicedAt: string;
  summary: string;
  observations: { conceptKey: string; capability: string; observation: string; assisted: boolean }[];
  source: "gpt";
}
export const PRACTICE_KIND_LABELS: Record<PracticeKind, string> = { conjugation: "形態變化", grammar: "文法", particle: "助詞", structure: "句子結構", collocation: "搭配", reading: "閱讀" };
export const CAPABILITY_LABELS: Record<PracticeCapability, string> = { recognition: "理解", production: "產出", usage: "應用" };
const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const text = (v: unknown, max = 6000): v is string => typeof v === "string" && v.trim().length > 0 && v.length <= max;
const keysAllowed = (v: Record<string, unknown>, keys: string[]) => Object.keys(v).every(key => keys.includes(key));
export function isLearningPractice(value: unknown): value is LearningPractice {
  if (!record(value)) return false;
  return keysAllowed(value, ["version", "kind", "conceptKey", "title", "capability", "learned", "enabled", "formId", "variants", "activeVariantId"]) && value.version === 1 && Object.keys(PRACTICE_KIND_LABELS).includes(String(value.kind)) &&
    Object.keys(CAPABILITY_LABELS).includes(String(value.capability)) && text(value.conceptKey, 160) && text(value.title, 160) &&
    typeof value.learned === "boolean" && typeof value.enabled === "boolean" &&
    (value.formId === undefined || text(value.formId, 160)) && Array.isArray(value.variants) && value.variants.length > 0 && value.variants.length <= 30 &&
    value.variants.every(v => record(v) && keysAllowed(v, ["id", "prompt", "answer", "acceptedAnswers", "explanation", "hint", "stimulus", "contentKey", "errorCategory"]) && text(v.id, 160) && text(v.prompt) && text(v.answer) &&
      text(v.explanation) && Array.isArray(v.acceptedAnswers) && v.acceptedAnswers.length <= 30 && v.acceptedAnswers.every(a => text(a)) &&
      (v.hint === undefined || text(v.hint)) && (v.stimulus === undefined || text(v.stimulus, 20000)) && (v.contentKey === undefined || text(v.contentKey, 160)) &&
      (v.errorCategory === undefined || ["form", "attachment", "particle", "structure", "meaning", "vocabulary"].includes(String(v.errorCategory)))) &&
    new Set(value.variants.map(v => v.id)).size === value.variants.length &&
    (value.activeVariantId === undefined || value.variants.some(v => v.id === value.activeVariantId));
}
export function isCoachReport(value: unknown): value is CoachReport {
  return record(value) && keysAllowed(value, ["version", "source", "externalId", "summary", "practicedAt", "observations"]) && value.version === 1 && value.source === "gpt" && text(value.externalId, 160) &&
    text(value.summary) && typeof value.practicedAt === "string" && Number.isFinite(Date.parse(value.practicedAt)) &&
    Array.isArray(value.observations) && value.observations.length <= 30 && value.observations.every(o => record(o) && keysAllowed(o, ["conceptKey", "capability", "observation", "assisted"]) && text(o.conceptKey, 160) && text(o.capability, 80) && text(o.observation, 1000) && typeof o.assisted === "boolean");
}
export function isPracticeEligible(item: LearningItem): boolean {
  return !item.reviewPaused && !item.archivedAt && !item.coachReport && (item.language !== "en" || !!item.englishPractice) && (!item.practice || item.practice.learned && item.practice.enabled);
}
export function practiceExposureKey(item: LearningItem): string {
  return item.practice?.conceptKey ?? `word:${item.id}`;
}
/** JSONB reorders object keys; semantic comparisons must ignore that ordering. */
export function canonicalJson(value: unknown): string {
  const sort = (v: unknown): unknown => Array.isArray(v) ? v.map(sort) : record(v) ? Object.fromEntries(Object.keys(v).sort().filter(k => v[k] !== undefined).map(k => [k, sort(v[k])])) : v;
  return JSON.stringify(sort(value)) ?? "null";
}
function exposureKeys(item: LearningItem): string[] {
  const variantKey = item.practice?.activeVariantId ? activePracticeVariant(item)?.contentKey : undefined;
  return [practiceExposureKey(item), ...(variantKey ? [variantKey] : []), ...(!item.practice ? [`ja-word:${item.answer}:${item.reading ?? ""}`] : [])];
}
export function spacePracticeUnits(units: StudySessionPlannedUnit[], items: LearningItem[]): StudySessionPlannedUnit[] {
  const byId = new Map(items.map(item => [item.id, item]));
  const keys = (unit: StudySessionPlannedUnit) => {
    const item = unit.itemSnapshot ?? byId.get(unit.learningItemId);
    return item ? exposureKeys(item) : [unit.learningItemId];
  };
  const remaining = [...units]; const ordered: StudySessionPlannedUnit[] = [];
  while (remaining.length) {
    const recent = new Set(ordered.slice(-3).flatMap(keys));
    const position = remaining.findIndex(unit => keys(unit).every(key => !recent.has(key)));
    ordered.push(remaining.splice(position < 0 ? 0 : position, 1)[0]);
  }
  return ordered;
}
export function recentlyExposed(item: LearningItem, attempts: ReviewAttempt[], now: Date): boolean {
  const keys = new Set(exposureKeys(item));
  return [...attempts].sort((a, b) => a.reviewedAt.localeCompare(b.reviewedAt) || a.id.localeCompare(b.id)).slice(-3).some(attempt => now.getTime() - Date.parse(attempt.reviewedAt) >= 0 && now.getTime() - Date.parse(attempt.reviewedAt) < 180_000 &&
    (attempt.abilityEvidence?.question ? exposureKeys(attempt.abilityEvidence.question) : [`word:${attempt.learningItemId}`]).some(key => keys.has(key)));
}
export function activePracticeVariant(item: Pick<LearningItem, "practice">): PracticeVariant | undefined {
  const practice = item.practice;
  return practice?.variants.find(v => v.id === practice.activeVariantId) ?? practice?.variants[0];
}
/** These catalog packs contain different vocabulary tasks, not interchangeable parallel questions. */
export function hasMixedVocabularyTasks(item: LearningItem): boolean {
  const ids = new Set(item.practice?.variants.map(v => v.id));
  return ["reading", "orthography", "meaning"].every(id => ids.has(id));
}
/** Rotate from recorded questions, independent of random UI rerenders. */
export function freezePracticeQuestion(item: LearningItem, attempts: ReviewAttempt[], exposedContent = new Set<string>(), verifying = false, seenQuestions: LearningItem[] = []): LearningItem {
  if (!item.practice) return structuredClone(item);
  const relevant = attempts.filter(a => a.learningItemId === item.id && a.abilityEvidence?.question.practice && (a.abilityEvidence?.attemptNumber ?? 0) === 0)
    .sort((a, b) => a.reviewedAt.localeCompare(b.reviewedAt) || a.id.localeCompare(b.id));
  // Keep one parallel question out of ordinary practice until a delayed check.
  const allVariants = item.practice.variants;
  const variants = !verifying && allVariants.length >= 3 && !hasMixedVocabularyTasks(item) ? allVariants.slice(0, -1) : allVariants;
  const lastId = relevant.at(-1)?.abilityEvidence?.question.practice?.activeVariantId;
  const last = variants.findIndex(v => v.id === lastId);
  const rotated = [...variants.slice(last + 1), ...variants.slice(0, last + 1)];
  const questionKey = (v: PracticeVariant) => canonicalJson({ prompt: v.prompt, stimulus: v.stimulus, answer: v.answer, acceptedAnswers: v.acceptedAnswers });
  const seen = new Set([...relevant.map(a => a.abilityEvidence?.question), ...seenQuestions].filter(q => q?.id === item.id)
    .map(q => q?.practice?.variants.find(v => v.id === q.practice?.activeVariantId)).filter((v): v is PracticeVariant => !!v).map(questionKey));
  const variant = (verifying ? rotated.find(v => !seen.has(questionKey(v)) && v.prompt !== item.exampleSentence) : undefined) ?? rotated.find(variant => !variant.contentKey || !exposedContent.has(variant.contentKey)) ?? rotated[0];
  return { ...structuredClone(item), promptZh: variant.prompt, answer: variant.answer, reading: undefined, acceptedAnswers: [...variant.acceptedAnswers],
    ...(verifying ? { verificationQuestion: { key: `parallel:${item.id}:${variant.id}`, kind: "parallel" as const, novel: !seen.has(questionKey(variant)), basePrompt: item.promptZh } } : {}),
    explanation: variant.explanation, practice: { ...structuredClone(item.practice), activeVariantId: variant.id } };
}
export function practiceEvidence(item: LearningItem, schedules: ScheduleState[], attempts: ReviewAttempt[]) {
  const schedule = schedules.find(s => s.learningItemId === item.id && s.ability === "recall");
  const evidence = attempts.filter(a => a.learningItemId === item.id && a.result === "correct" && !a.usedHint && a.abilityEvidence?.wasDue && a.abilityEvidence.attemptNumber === 0 &&
    a.abilityEvidence.question.practice?.conceptKey === item.practice?.conceptKey && a.abilityEvidence.question.practice?.capability === item.practice?.capability &&
    canonicalJson(a.abilityEvidence.question.practice?.variants) === canonicalJson(item.practice?.variants));
  const variants = new Set(evidence.map(a => a.abilityEvidence?.question.practice?.activeVariantId).filter(Boolean));
  const dates = new Set(evidence.map(a => a.abilityEvidence!.day));
  const status = evidenceStatus(schedule);
  const requiredVariants = Math.min(3, item.practice?.variants.length ?? 1);
  return { status: status === "mastered" && (variants.size < requiredVariants || dates.size < 5) ? "learning" as const : status,
    independentDays: dates.size, successfulVariants: variants.size, requiredVariants, dueAt: schedule?.dueAt };
}
export function practiceError(item: LearningItem, raw: string): { category: string; explanation: string } | undefined {
  const variant = activePracticeVariant(item);
  if (!variant) return;
  if (!raw.trim()) return { category: "想不起來", explanation: "這次沒有回想出答案；不能單憑這次判斷是規則還是單字不熟。" };
  const expected = [variant.answer, ...variant.acceptedAnswers].map(normalizeForComparison);
  if (expected.includes(normalizeForComparison(raw))) return;
  const label = { form: "形式不符", attachment: "接續不符", particle: "助詞不符", structure: "句子結構", meaning: "語意辨別", vocabulary: "詞彙搭配" };
  return { category: label[variant.errorCategory ?? "meaning"], explanation: variant.explanation + "（此分類只指出本題目標，未推定其他能力。）" };
}
export function practiceInput(practice: LearningPractice, source: NewLearningItemInput["source"] = "manual"): NewLearningItemInput {
  if (!isLearningPractice(practice)) throw new Error("練習內容格式不完整。");
  const first = practice.variants[0];
  return { language: "ja", type: practice.kind === "collocation" ? "collocation" : "grammar", promptZh: `${practice.title}｜${CAPABILITY_LABELS[practice.capability]}`,
    answer: first.answer, acceptedAnswers: first.acceptedAnswers, explanation: first.explanation, source, tags: [PRACTICE_KIND_LABELS[practice.kind]], practice: structuredClone(practice) };
}
