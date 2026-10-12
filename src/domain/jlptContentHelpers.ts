import type { CatalogEntry } from "./japanesePracticeCatalog";
import type { LearningPractice, PracticeVariant } from "./learningPractice";
import type { JlptLevel } from "./jlptPracticeCatalog";

export function jlptPack(level: JlptLevel, key: string, title: string, kind: LearningPractice["kind"], variants: PracticeVariant[], description: string): CatalogEntry {
  const conceptKey = `jlpt:${level.toLowerCase()}:${key}`;
  // Exam-style choices measure recognition, including vocabulary usage questions.
  const capability = "recognition";
  const label = `${level}｜${title}`;
  return { id: `${conceptKey}:${capability}`, title: label, category: `${level} ${title.split("：")[0]}`, description: `${description} 原創備考練習；非歷屆真題。`,
    practice: { version: 1, conceptKey, title: label, kind, capability, learned: false, enabled: false, variants } };
}

/** Canonical answer is text; a numbered answer is also accepted by the existing grader. */
export function jlptChoice(id: string, question: string, options: readonly [string, string, string, string], correct: number, explanation: string, stimulus?: string, errorCategory: PracticeVariant["errorCategory"] = "meaning"): PracticeVariant {
  return { id, prompt: `${question}\n請輸入選項內容或編號。\n${options.map((o, i) => `${i + 1}. ${o}`).join("\n")}`, answer: options[correct], acceptedAnswers: [String(correct + 1)], explanation, ...(stimulus ? { stimulus } : {}), errorCategory };
}

export type GrammarRow = [question: string, options: [string, string, string, string], correct: number, explanation: string];
export function jlptGrammar(level: JlptLevel, key: string, title: string, rows: GrammarRow[], kind: LearningPractice["kind"] = "grammar") {
  return jlptPack(level, key, title, kind, rows.map((r, i) => jlptChoice(`${key}-${i + 1}`, ...r, undefined, kind === "particle" ? "particle" : "attachment")), "依上下文選擇接續與語意，解析指出容易混淆的形式。");
}
