import type { CatalogEntry } from "./japanesePracticeCatalog";
import type { PracticeVariant } from "./learningPractice";
import { JLPT_PRODUCTION_ROWS } from "./jlptProductionRows";

/**
 * One typed fill-in question: the sentence with （　） for the blank, the answer to type, every other
 * acceptable way to write it, a short instruction naming the form to produce, and why it is right.
 */
export type ProductionRow = [stem: string, answer: string, acceptedAnswers: string[], hint: string, explanation: string];

/**
 * The typed layer of a grammar concept. It shares the concept key with the multiple-choice entry, so the two are
 * spaced apart in a round, share one concept card, and only typed success counts as producing the form.
 */
export function productionEntries(recognition: CatalogEntry[], rows: Record<string, ProductionRow[]> = JLPT_PRODUCTION_ROWS): CatalogEntry[] {
  return recognition.flatMap((entry): CatalogEntry[] => {
    const typed = rows[entry.practice.conceptKey];
    if (!typed || entry.practice.capability !== "recognition") return [];
    const variants: PracticeVariant[] = typed.map(([stem, answer, acceptedAnswers, hint, explanation], index) => ({
      id: `typed-${index + 1}`,
      prompt: `${stem}\n${hint}`,
      answer,
      acceptedAnswers,
      explanation,
      errorCategory: entry.practice.kind === "particle" ? "particle" : "attachment",
    }));
    return [{
      id: `${entry.practice.conceptKey}:production`,
      title: entry.title,
      category: entry.category,
      description: `${entry.description.replace(/依上下文選擇.*?。/, "")}打字寫出正確形式。`.trim(),
      practice: { ...structuredClone(entry.practice), capability: "production", variants },
    }];
  });
}
