import type { LearningItem } from "./types";
import { activeEnglishVariant } from "./englishPractice";
import { activePracticeVariant } from "./learningPractice";
import { normalizeForComparison } from "./text";

/** Display only: never rewrite stored questions, versions or old attempts. */
export function learnerText(text: string): string {
  return text
    .replaceAll("五段／第一類", "第一類")
    .replaceAll("一段／第二類", "第二類")
    .replaceAll("五段動詞", "第一類動詞")
    .replaceAll("一段動詞", "第二類動詞")
    .replaceAll("五段：", "第一類：")
    .replaceAll("一段去", "第二類去");
}
export function practiceTitle(item: Pick<LearningItem, "practice">): string {
  const p = item.practice;
  if (!p) return "";
  if (p.conceptKey === "verb:class") return "第一／二／三類動詞辨認";
  if (p.formId?.startsWith("te_iru_"))
    return p.title.replace("ている", "現在進行／狀態");
  return learnerText(p.title);
}
export function temporalPracticeConcepts(
  items: LearningItem[],
  tense: "progressive" | "present" | "past",
): string[] {
  return [
    ...new Set(
      items
        .filter((item) => {
          const p = item.practice,
            id = p?.formId;
          if (!id || !p?.learned || !p.enabled || item.archivedAt) return false;
          if (tense === "progressive") return id.startsWith("te_iru_");
          if (tense === "past") return id === "ta" || id.includes("_past_");
          return (
            !id.startsWith("te_iru_") &&
            (id === "dictionary" || id === "nai" || id.includes("_present_"))
          );
        })
        .map((item) => item.practice!.conceptKey),
    ),
  ];
}
/** Existing semantic items can use choices immediately, including frozen sessions. */
export function practiceChoices(item: LearningItem): string[] {
  if (item.englishPractice) return activeEnglishVariant(item)?.choices.map(c => c.text) ?? [];
  const p = item.practice,
    v = activePracticeVariant(item);
  if (!p || !v || (p.kind === "conjugation" && p.capability === "production"))
    return [];
  const correct = new Set(
    [v.answer, ...v.acceptedAnswers].map(normalizeForComparison),
  );
  // JLPT content supplies its own distractors. Preserve their order and numbering,
  // rather than mixing answers from other questions into this question's choices.
  if (p.conceptKey.startsWith("jlpt:")) {
    const numbered = v.prompt.split("\n").slice(-4);
    if (!numbered.every((line, i) => line.startsWith(`${i + 1}. `))) return [];
    const options = numbered.map(line => line.slice(3));
    return new Set(options.map(normalizeForComparison)).size === 4 &&
      options.filter(option => correct.has(normalizeForComparison(option))).length === 1
      ? options : [];
  }
  let pool = p.variants.map((q) => q.answer);
  if (p.conceptKey === "verb:class") pool = ["第一類", "第二類", "第三類"];
  if (p.kind === "particle") pool = ["は", "が", "を", "に", "で", "へ", "と"];
  if (p.kind === "structure" && p.capability === "production") {
    const parts = v.prompt.split("\n").at(-1)!.split("／");
    if (parts.length < 3) return [];
    pool = [
      parts.slice().reverse().join(""),
      [parts.at(-1), ...parts.slice(0, -1)].join(""),
      [...parts.slice(1), parts[0]].join(""),
    ];
  }
  if (
    p.kind === "grammar" &&
    p.capability === "usage" &&
    v.answer.endsWith("います")
  ) {
    pool = [
      v.answer.replace(/います$/, "いました"),
      v.answer.replace(/います$/, "いません"),
      v.answer.replace(/います$/, "いませんでした"),
    ];
  }
  const seen = new Set<string>();
  const wrong = pool
    .filter((answer) => {
      const key = normalizeForComparison(answer);
      if (correct.has(key) || seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, 3);
  if (!wrong.length) return [];
  // Stable across rerenders/reloads; the correct option is not always first.
  const seed = [...`${p.conceptKey}:${v.id}`].reduce(
    (n, c) => (Math.imul(n, 31) + c.charCodeAt(0)) >>> 0,
    0,
  );
  const choices = [...wrong];
  choices.splice(seed % (wrong.length + 1), 0, v.answer);
  return choices;
}
/** Choice cues cannot establish independent production/usage recall evidence. */
export function choiceIsAssisted(item: LearningItem): boolean {
  return (
    practiceChoices(item).length > 0 &&
    !item.englishPractice && item.practice?.capability !== "recognition"
  );
}
