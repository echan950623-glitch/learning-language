import { describe, expect, it } from "vitest";
import { isConceptCard } from "./conceptCards";
import { JLPT_CONCEPT_CARDS } from "./jlptConceptCards";
import { getJlptPracticeCatalog } from "./jlptPracticeCatalog";

const entries = getJlptPracticeCatalog().filter(entry => !entry.practice.conceptKey.includes(":word:"));
const catalogKeys = entries.map(entry => entry.practice.conceptKey);
const isGrammar = (key: string) => key.includes(":bunpou:") && !key.includes("text-grammar");

describe("JLPT concept cards", () => {
  it("has exactly one card for every non-word concept in the catalog", () => {
    expect(Object.keys(JLPT_CONCEPT_CARDS).sort()).toEqual([...new Set(catalogKeys)].sort());
  });

  it("every card is a well-formed concept card", () => {
    for (const [key, card] of Object.entries(JLPT_CONCEPT_CARDS)) {
      expect(isConceptCard(card), key).toBe(true);
    }
  });

  it("grammar cards state the connection and give at least two translated examples", () => {
    for (const [key, card] of Object.entries(JLPT_CONCEPT_CARDS).filter(([key]) => isGrammar(key))) {
      expect(card.connection, key).toBeTruthy();
      expect(card.examples.length, key).toBeGreaterThanOrEqual(2);
      for (const example of card.examples) expect(example.zh, `${key} ${example.ja}`).toBeTruthy();
    }
  });

  it("strategy cards omit the connection and still translate their example", () => {
    for (const [key, card] of Object.entries(JLPT_CONCEPT_CARDS).filter(([key]) => !isGrammar(key))) {
      expect(card.connection, key).toBeUndefined();
      expect(card.examples.length, key).toBeGreaterThanOrEqual(1);
      for (const example of card.examples) expect(example.zh, `${key} ${example.ja}`).toBeTruthy();
    }
  });

  it("keeps the text short enough for a card", () => {
    for (const [key, card] of Object.entries(JLPT_CONCEPT_CARDS)) {
      expect(card.meaning.length, `${key} meaning`).toBeLessThanOrEqual(120);
      expect((card.contrast ?? "").length, `${key} contrast`).toBeLessThanOrEqual(120);
      for (const example of card.examples) expect(example.ja.length, `${key} ${example.ja}`).toBeLessThanOrEqual(40);
    }
  });

  it("never gives away a question: no example sentence appears in a prompt, stimulus or answer", () => {
    for (const entry of entries) {
      const card = JLPT_CONCEPT_CARDS[entry.practice.conceptKey];
      if (!card) continue;
      for (const example of card.examples) {
        for (const variant of entry.practice.variants) {
          for (const field of [variant.prompt, variant.stimulus, variant.answer]) {
            expect(field ?? "", `${entry.practice.conceptKey} ${example.ja}`).not.toContain(example.ja);
          }
        }
      }
    }
  });
});
