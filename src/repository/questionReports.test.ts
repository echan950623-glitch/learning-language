import { describe, expect, it } from "vitest";
import { addQuestionReport, clearQuestionReports, formatQuestionReports, listQuestionReports, reportedQuestionKeys, type QuestionReport } from "./questionReports";
import { freezePracticeQuestion, practiceInput } from "../domain/learningPractice";
import { getJlptPracticeCatalog } from "../domain/jlptPracticeCatalog";
import type { LearningItem } from "../domain/types";

function memoryStorage(): Storage {
  const values = new Map<string, string>();
  return {
    get length() { return values.size; },
    key: index => [...values.keys()][index] ?? null,
    getItem: key => values.get(key) ?? null,
    setItem: (key, value) => { values.set(key, String(value)); },
    removeItem: key => { values.delete(key); },
    clear: () => values.clear(),
  };
}
const report = (variantId: string, extra: Partial<QuestionReport> = {}): QuestionReport => ({ conceptKey: "jlpt:n4:bunpou:experience", variantId, prompt: "題幹\n1. あ\n2. い", answer: "あ", at: "2026-11-12T00:00:00.000Z", ...extra });

describe("question reports", () => {
  it("stores, lists and de-duplicates reports, newest note winning", () => {
    const storage = memoryStorage();
    addQuestionReport(report("a"), storage);
    addQuestionReport(report("b", { note: "  答案也可以是い  " }), storage);
    addQuestionReport(report("a", { note: "第二次" }), storage);
    expect(listQuestionReports(storage).map(r => [r.variantId, r.note])).toEqual([["b", "答案也可以是い"], ["a", "第二次"]]);
    expect([...reportedQuestionKeys(storage)].sort()).toEqual(["jlpt:n4:bunpou:experience#a", "jlpt:n4:bunpou:experience#b"]);
  });
  it("survives unreadable or hand-edited storage", () => {
    const storage = memoryStorage();
    storage.setItem("learning-language:question-reports:v1", "{not json");
    expect(listQuestionReports(storage)).toEqual([]);
    storage.setItem("learning-language:question-reports:v1", JSON.stringify([{ conceptKey: "x" }, report("ok")]));
    expect(listQuestionReports(storage).map(r => r.variantId)).toEqual(["ok"]);
    clearQuestionReports(storage);
    expect(listQuestionReports(storage)).toEqual([]);
  });
  it("formats text that can be pasted into a conversation", () => {
    const text = formatQuestionReports([report("a", { note: "選項重複" })]);
    expect(text).toContain("題目回報（1 題）");
    expect(text).toContain("jlpt:n4:bunpou:experience / a");
    expect(text).toContain("題目：題幹 ／ 1. あ ／ 2. い");
    expect(text).toContain("說明：選項重複");
    expect(formatQuestionReports([])).toBe("");
  });
});

describe("flagged questions leave the rotation", () => {
  const entry = getJlptPracticeCatalog().find(candidate => candidate.practice.conceptKey === "jlpt:n4:bunpou:experience" && candidate.practice.capability === "recognition")!;
  const item: LearningItem = { ...practiceInput({ ...entry.practice, learned: true, enabled: true }), id: "item", status: "learning", createdAt: "2026-11-01T00:00:00Z", isSeed: false };
  const ids = entry.practice.variants.map(variant => variant.id);
  const chosen = (excluded: string[]) => freezePracticeQuestion(item, [], new Set(), false, [], new Set(excluded.map(id => `${entry.practice.conceptKey}#${id}`))).practice!.activeVariantId;

  it("never picks a flagged variant while others remain", () => {
    for (const flagged of ids.slice(0, 2)) expect(chosen([flagged])).not.toBe(flagged);
    expect(chosen([ids[0], ids[1]])).toBe(ids[2]);
  });
  it("still asks the concept when every variant is flagged", () => {
    expect(ids).toContain(chosen(ids));
  });
  it("keeps the stored question set intact", () => {
    const frozen = freezePracticeQuestion(item, [], new Set(), false, [], new Set([`${entry.practice.conceptKey}#${ids[0]}`]));
    expect(frozen.practice!.variants).toEqual(entry.practice.variants);
  });
});
