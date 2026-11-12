import type { LearningItem } from "./types";

/** Level assignments are this project's editorial arrangement; JLPT publishes no official syllabus. */
export const JLPT_LEVELS = ["N5", "N4", "N3", "N2"] as const;
export type JlptLevel = (typeof JLPT_LEVELS)[number];
/** Words saved before levels existed carry no level; they stay reachable as their own group. */
export type LevelChoice = JlptLevel | "unleveled";
export const LEVEL_CHOICES: readonly LevelChoice[] = [...JLPT_LEVELS, "unleveled"];
export const LEVEL_LABELS: Record<LevelChoice, string> = { N5: "N5", N4: "N4", N3: "N3", N2: "N2", unleveled: "未分級" };

/** Exam sections the built-in content is organised by. Listening is out of scope. */
export const JLPT_QUESTION_TYPES = {
  goi: "文字語彙",
  bunpou: "文法",
  narabekae: "句子重組",
  dokkai: "讀解",
} as const;
export type JlptQuestionType = keyof typeof JLPT_QUESTION_TYPES;

const isLevel = (value: string): value is JlptLevel => (JLPT_LEVELS as readonly string[]).includes(value);

/** Built-in concepts are keyed `jlpt:<level>:<type>:<concept>`, so level and type need no stored field. */
export function parseJlptConceptKey(conceptKey: string): { level: JlptLevel; type: JlptQuestionType; concept: string } | undefined {
  const [prefix, rawLevel, type, ...concept] = conceptKey.split(":");
  const level = rawLevel?.toUpperCase() ?? "";
  if (prefix !== "jlpt" || !isLevel(level) || !type || !(type in JLPT_QUESTION_TYPES) || !concept.length) return undefined;
  return { level, type: type as JlptQuestionType, concept: concept.join(":") };
}

/** Practice content takes its level from the concept key; a word takes it from a level tag such as "N4". */
export function itemLevel(item: Pick<LearningItem, "practice" | "tags">): JlptLevel | undefined {
  if (item.practice) return parseJlptConceptKey(item.practice.conceptKey)?.level;
  return item.tags.map(tag => tag.trim().toUpperCase()).find(isLevel);
}

/** An empty selection means no restriction. */
export function matchesLevels(item: Pick<LearningItem, "practice" | "tags">, levels: readonly LevelChoice[]): boolean {
  return !levels.length || levels.includes(itemLevel(item) ?? "unleveled");
}
