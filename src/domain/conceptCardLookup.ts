import type { ConceptCard } from "./conceptCards";
import { parseJlptConceptKey, type JlptLevel } from "./jlptLevels";
import { JLPT_WORDS } from "./jlptPracticeCatalog";
import { JLPT_CONCEPT_CARDS } from "./jlptConceptCards";
import type { LearningItem } from "./types";

export interface ConceptCardView {
  level?: JlptLevel;
  /** Heading without the level and section prefixes stored in the practice title. */
  title: string;
  card?: ConceptCard;
}

/** Built-in word packs carry their own meaning and example sentence, so their cards need no separate text. */
function wordCard(concept: string): ConceptCard | undefined {
  const word = JLPT_WORDS.find(([, kanji]) => concept === `word:${kanji}`);
  return word ? { meaning: word[3], examples: [{ ja: word[4] }] } : undefined;
}

export function conceptCardFor(item: Pick<LearningItem, "practice">): ConceptCardView | undefined {
  if (!item.practice) return undefined;
  const parsed = parseJlptConceptKey(item.practice.conceptKey);
  const title = item.practice.title.replace(/^N\d｜/, "").replace(/^[^：]{1,8}：/, "");
  const card = JLPT_CONCEPT_CARDS[item.practice.conceptKey] ?? (parsed ? wordCard(parsed.concept) : undefined);
  return { level: parsed?.level, title, card };
}
