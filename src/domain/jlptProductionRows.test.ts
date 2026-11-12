import { describe, expect, it } from "vitest";
import { gradeAttempt } from "./grading";
import { JLPT_CONCEPT_CARDS } from "./jlptConceptCards";
import { getJlptPracticeCatalog } from "./jlptPracticeCatalog";
import { isLearningPractice } from "./learningPractice";

const BLANK = "（　）";
const EXPECTED_KEYS = [
  ...["particles", "adjectives", "existence", "te-request", "desire-purpose", "comparison", "before-after", "invitation"].map(key => `jlpt:n5:bunpou:${key}`),
  ...["experience", "plans", "obligation", "potential", "giving", "conditional", "preparation", "try", "appearance", "purpose", "time", "simultaneous", "nominalization", "change", "advice", "indirect", "passive", "honorific", "transitivity"].map(key => `jlpt:n4:bunpou:${key}`),
];

const catalog = getJlptPracticeCatalog();
const production = catalog.filter(entry => entry.practice.capability === "production");
const recognitionFor = (key: string) => catalog.filter(entry => entry.practice.capability === "recognition" && entry.practice.conceptKey === key);
const optionLines = (prompt: string) => prompt.split("\n").map(line => /^\d+\. (.+)$/.exec(line)?.[1]).filter((option): option is string => option !== undefined);
const questionLine = (prompt: string) => prompt.split("\n")[0];

describe("JLPT typed production rows", () => {
  it("covers exactly the grammar packs, with at least three variants each", () => {
    expect(production.map(entry => entry.practice.conceptKey).sort()).toEqual([...EXPECTED_KEYS].sort());
    for (const entry of production) expect(entry.practice.variants.length, entry.practice.conceptKey).toBeGreaterThanOrEqual(3);
  });

  it("builds valid learning practices", () => {
    for (const entry of production) expect(isLearningPractice(entry.practice), entry.practice.conceptKey).toBe(true);
  });

  it("has well-formed stems, answers, accepted answers and explanations", () => {
    for (const entry of production) {
      for (const variant of entry.practice.variants) {
        const label = `${entry.practice.conceptKey} ${variant.id}`;
        const stem = variant.prompt.slice(0, variant.prompt.lastIndexOf("\n"));
        expect(stem.split(BLANK).length - 1, label).toBe(1);
        expect(variant.answer.trim(), label).not.toBe("");
        expect(stem, label).not.toContain(variant.answer);
        expect(new Set(variant.acceptedAnswers).size, label).toBe(variant.acceptedAnswers.length);
        expect(variant.acceptedAnswers, label).not.toContain(variant.answer);
        expect(variant.explanation.trim(), label).not.toBe("");
      }
    }
  });

  it("grades the answer and every accepted answer as correct", () => {
    for (const entry of production) {
      for (const variant of entry.practice.variants) {
        for (const input of [variant.answer, ...variant.acceptedAnswers]) {
          const result = gradeAttempt({ ability: "recall", rawInput: input, expectedAnswer: variant.answer, acceptedAnswers: variant.acceptedAnswers });
          expect(result.correct, `${entry.practice.conceptKey} ${variant.id} ${input}`).toBe(true);
        }
      }
    }
  });

  // Particle packs are exempt: every particle (に, を, で, が, と) is a distractor somewhere in the multiple-choice
  // questions, so the uniqueness of a typed particle blank rests on the stem and hint instead.
  it("never accepts a multiple-choice distractor as the answer to a typed variant", () => {
    for (const entry of production.filter(item => item.practice.kind !== "particle")) {
      const distractors = recognitionFor(entry.practice.conceptKey).flatMap(recognition =>
        recognition.practice.variants.flatMap(variant => optionLines(variant.prompt).filter(option => option !== variant.answer)));
      expect(distractors.length, entry.practice.conceptKey).toBeGreaterThan(0);
      for (const variant of entry.practice.variants) {
        for (const distractor of distractors) {
          const result = gradeAttempt({ ability: "recall", rawInput: distractor, expectedAnswer: variant.answer, acceptedAnswers: variant.acceptedAnswers });
          expect(result.correct, `${entry.practice.conceptKey} ${variant.id} accepts distractor ${distractor}`).toBe(false);
        }
      }
    }
  });

  it("reuses no multiple-choice question sentence or concept-card example", () => {
    for (const entry of production) {
      const key = entry.practice.conceptKey;
      const taken = new Set<string>(JLPT_CONCEPT_CARDS[key].examples.map(example => example.ja));
      for (const recognition of recognitionFor(key)) for (const variant of recognition.practice.variants) {
        const line = questionLine(variant.prompt);
        taken.add(line);
        taken.add(line.replace(BLANK, variant.answer));
      }
      for (const variant of entry.practice.variants) {
        const stem = variant.prompt.slice(0, variant.prompt.lastIndexOf("\n"));
        for (const line of [...stem.split("\n"), ...stem.replace(BLANK, variant.answer).split("\n")]) {
          expect(taken.has(line), `${key} ${variant.id} ${line}`).toBe(false);
        }
      }
    }
  });
});
