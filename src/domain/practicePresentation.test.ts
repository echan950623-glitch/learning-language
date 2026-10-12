import { describe, expect, it } from "vitest";
import { getJapanesePracticeCatalog } from "./japanesePracticeCatalog";
import { practiceInput, freezePracticeQuestion } from "./learningPractice";
import {
  learnerText,
  practiceTitle,
  practiceChoices,
  choiceIsAssisted,
  temporalPracticeConcepts,
} from "./practicePresentation";
import type { LearningItem } from "./types";
function item(id: string): LearningItem {
  const practice = getJapanesePracticeCatalog().find(
    (entry) => entry.id === id,
  )!.practice;
  return freezePracticeQuestion(
    {
      ...practiceInput(practice),
      id,
      status: "new",
      isSeed: false,
      createdAt: "2026-10-08T00:00:00Z",
    },
    [],
  );
}
describe("learner-facing answer choices preserve stored evidence", () => {
  it("selects the learner's tenses without classification or disabled forms", () => {
    const items = [
      item("form:te_iru_polite_present_positive:production"),
      item("form:polite_present_positive:production"),
      item("form:ta:production"),
      item("verb:class:recognition"),
    ];
    items.forEach((i) => {
      i.practice!.learned = true;
      i.practice!.enabled = true;
    });
    expect(temporalPracticeConcepts(items, "progressive")).toEqual([
      "form:te_iru_polite_present_positive",
    ]);
    expect(temporalPracticeConcepts(items, "present")).toEqual([
      "form:polite_present_positive",
    ]);
    expect(temporalPracticeConcepts(items, "past")).toEqual(["form:ta"]);
    items[2].practice!.enabled = false;
    expect(temporalPracticeConcepts(items, "past")).toEqual([]);
  });
  it("offers three classes without requiring typing, while actual conjugation remains production", () => {
    const classification = item("verb:class:recognition");
    expect(practiceChoices(classification).sort()).toEqual(
      ["第一類", "第三類", "第二類"].sort(),
    );
    expect(choiceIsAssisted(classification)).toBe(false);
    expect(practiceChoices(item("form:te:production"))).toEqual([]);
  });
  it("has stable options on reload, exactly one accepted answer and no data mutation", () => {
    const grammar = item("grammar:teiru:recognition"),
      original = structuredClone(grammar);
    const choices = practiceChoices(grammar);
    expect(choices).toEqual(practiceChoices(structuredClone(grammar)));
    expect(choices).toContain(grammar.answer);
    expect(
      choices.filter((c) =>
        [grammar.answer, ...grammar.acceptedAnswers!].includes(c),
      ),
    ).toHaveLength(1);
    expect(grammar).toEqual(original);
  });
  it("marks conversion of usage and production to choices assisted, preventing independent recall evidence", () => {
    expect(choiceIsAssisted(item("grammar:teiru:usage"))).toBe(true);
    expect(choiceIsAssisted(item("structure:order:production"))).toBe(true);
    expect(practiceChoices(item("structure:order:production"))).toHaveLength(4);
    expect(practiceChoices(item("collocation:yakusoku:usage"))).toHaveLength(3);
  });
  it("offers semantic reading and particle choices, removing accepted alternatives from distractors", () => {
    expect(practiceChoices(item("reading:daily:recognition"))).toHaveLength(3);
    const p = item("particle:topic:usage");
    p.practice!.variants[0].acceptedAnswers = ["は"];
    p.acceptedAnswers = ["は"];
    expect(practiceChoices(p)).not.toContain("は");
    expect(practiceChoices(p)).toContain("が");
  });
  it("does not invent choices for one-answer custom questions or vocabulary", () => {
    const p = item("reading:daily:recognition");
    p.practice!.variants = p.practice!.variants.slice(0, 1);
    expect(practiceChoices(p)).toEqual([]);
    expect(practiceChoices({ ...p, practice: undefined })).toEqual([]);
  });
  it("uses class and tense vocabulary familiar to the learner without rewriting content", () => {
    const p = item("form:te_iru_polite_present_positive:production");
    expect(practiceTitle(p)).toContain("現在進行／狀態");
    expect(practiceTitle(item("verb:class:recognition"))).toBe(
      "第一／二／三類動詞辨認",
    );
    expect(learnerText("五段／第一類；一段動詞去る接て")).toBe(
      "第一類；第二類動詞去る接て",
    );
  });
});
