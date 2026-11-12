/**
 * A concept card teaches one practice concept before its questions are asked: what it means,
 * how it attaches, a couple of examples and what it is easily confused with.
 *
 * Cards live with the built-in content rather than in the learner's saved data, so a corrected
 * explanation reaches every account without rewriting stored items.
 */
export interface ConceptExample {
  /** Japanese sentence. */
  ja: string;
  /** Traditional Chinese translation. */
  zh?: string;
}

export interface ConceptCard {
  /** What the concept means or does, in Traditional Chinese. */
  meaning: string;
  /** How it attaches, e.g. 「動詞た形＋ことがある」. Omit for question-type strategy cards. */
  connection?: string;
  examples: ConceptExample[];
  /** What it is easily confused with and how to tell them apart. */
  contrast?: string;
}

export function isConceptCard(value: unknown): value is ConceptCard {
  if (!value || typeof value !== "object") return false;
  const card = value as Partial<ConceptCard>;
  const text = (v: unknown) => typeof v === "string" && v.trim().length > 0;
  return text(card.meaning) && (card.connection === undefined || text(card.connection)) &&
    (card.contrast === undefined || text(card.contrast)) && Array.isArray(card.examples) &&
    card.examples.every(example => !!example && text(example.ja) && (example.zh === undefined || text(example.zh)));
}
