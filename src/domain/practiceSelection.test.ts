import { describe, it, expect } from "vitest";
import { getJapanesePracticeCatalog } from "./japanesePracticeCatalog";
import { practiceInput } from "./learningPractice";
import {
  learnedPracticeItems,
  practiceCategory,
  selectMixedReviewUnits,
  selectPracticeUnits,
  type PracticeSelection,
} from "./practiceSelection";
import type { LearningItem, ReviewAttempt, ScheduleState } from "./types";
const now = new Date("2026-10-08T04:00:00Z");
const forms = getJapanesePracticeCatalog().filter(
  (c) => c.practice.kind === "conjugation",
);
const make = (
  index: number,
  id: string,
  extra: Partial<LearningItem> = {},
): LearningItem => ({
  ...practiceInput({ ...forms[index].practice, learned: true, enabled: true }),
  id,
  status: "new",
  createdAt: now.toISOString(),
  isSeed: false,
  ...extra,
});
const selection: PracticeSelection = {
  category: "conjugation",
  concepts: [],
  skill: "mixed",
  source: "recommended",
  questionCount: 5,
};
const attempt = (id: string): ReviewAttempt => ({
  id: `a-${id}`,
  learningItemId: id,
  language: "ja",
  exerciseId: "e",
  exerciseType: "recall",
  sessionId: "s",
  result: "incorrect",
  usedHint: false,
  responseTimeMs: 1,
  reviewedAt: now.toISOString(),
});
const schedule = (id: string, dueAt: string): ScheduleState => ({
  learningItemId: id,
  language: "ja",
  ability: "recall",
  dueAt,
  intervalDays: 1,
  streak: 0,
  lapseCount: 0,
});
describe("home practice selection", () => {
  it("excludes unknown, paused, archived and unrelated content", () => {
    const known = make(0, "known");
    const unknown = make(1, "unknown");
    unknown.practice!.learned = false;
    const paused = make(2, "paused");
    paused.practice!.enabled = false;
    expect(
      learnedPracticeItems(
        [
          known,
          unknown,
          paused,
          make(3, "archived", { archivedAt: now.toISOString() }),
        ],
        [],
        [],
        "conjugation",
      ).map((i) => i.id),
    ).toEqual(["known"]);
  });
  it("prioritizes due then wrong, keeps input unchanged, and respects count", () => {
    const items = [make(0, "other"), make(1, "wrong"), make(2, "due")];
    const original = structuredClone(items);
    const result = selectPracticeUnits(
      items,
      [attempt("wrong")],
      [schedule("due", "2026-10-07T00:00:00Z")],
      { ...selection, questionCount: 2 },
      now,
      () => 0.5,
    );
    expect(result.units.map((u) => u.learningItemId)).toEqual(["due", "wrong"]);
    expect(result.total).toBe(3);
    expect(items).toEqual(original);
  });
  it("filters explicit concept and capability without adding new forms", () => {
    const items = [make(0, "a"), make(1, "b")];
    expect(
      selectPracticeUnits(
        items,
        [],
        [],
        { ...selection, concepts: [items[1].practice!.conceptKey] },
        now,
      ).units.map((u) => u.learningItemId),
    ).toEqual(["b"]);
    expect(
      selectPracticeUnits(items, [], [], { ...selection, skill: "usage" }, now)
        .total,
    ).toBe(0);
  });
  it("keeps due and wrong sources distinct and preserves mode", () => {
    const items = [make(0, "a"), make(1, "b")];
    const schedules = [
      schedule("a", "2026-10-07T00:00:00Z"),
      schedule("b", "2026-10-09T00:00:00Z"),
    ];
    expect(
      selectPracticeUnits(
        items,
        [attempt("b")],
        schedules,
        { ...selection, source: "due" },
        now,
      ).units.map((u) => u.learningItemId),
    ).toEqual(["a"]);
    expect(
      selectPracticeUnits(
        items,
        [attempt("b")],
        schedules,
        { ...selection, source: "wrong" },
        now,
      ),
    ).toMatchObject({ mode: "wrong", units: [{ learningItemId: "b" }] });
    expect(
      selectPracticeUnits(
        items,
        [],
        schedules,
        { ...selection, source: "all" },
        now,
      ),
    ).toMatchObject({ mode: "full", total: 2 });
  });
  it("vocabulary inbox stays in today's plan and reading can be selected separately", () => {
    const word: LearningItem = {
      id: "word",
      language: "ja",
      type: "vocabulary",
      promptZh: "吃",
      answer: "食べる",
      reading: "たべる",
      source: "ai",
      tags: [],
      status: "new",
      createdAt: now.toISOString(),
      isSeed: false,
    };
    expect(
      selectPracticeUnits(
        [word],
        [],
        [],
        { ...selection, category: "vocabulary" },
        now,
      ).total,
    ).toBe(0);
    const result = selectPracticeUnits(
      [{ ...word, introducedAt: now.toISOString() }],
      [],
      [],
      { ...selection, category: "vocabulary", skill: "reading" },
      now,
    );
    expect(result.units).toEqual([
      { learningItemId: "word", ability: "reading", kind: "review" },
    ]);
  });
});

describe("mixed review across content areas", () => {
  const catalog = getJapanesePracticeCatalog();
  const learned = (entry: (typeof catalog)[number], id: string): LearningItem => ({
    ...practiceInput({ ...entry.practice, learned: true, enabled: true }), id, status: "new", createdAt: now.toISOString(), isSeed: false,
  });
  const word = (id: string): LearningItem => ({ id, language: "ja", type: "vocabulary", answer: `単語${id}`, reading: `たんご${id}`, promptZh: `詞義${id}`, source: "manual", tags: [], status: "learning", createdAt: now.toISOString(), isSeed: false, introducedAt: now.toISOString() });
  const conjugations = catalog.filter(c => c.practice.kind === "conjugation").slice(0, 6).map((c, n) => learned(c, `c${n}`));
  const other = catalog.find(c => c.practice.kind !== "conjugation")!;
  const items = [...conjugations, learned(other, "other"), word("w1"), word("w2")];

  it("takes turns between areas so a large area cannot fill the round", () => {
    const mixed = selectMixedReviewUnits(items, [], [], 4, now, () => 0.5);
    const areas = mixed.units.map(u => practiceCategory(items.find(i => i.id === u.learningItemId)!));
    expect(mixed.units).toHaveLength(4);
    expect(new Set(areas).size).toBe(3);
    expect(areas.filter(area => area === "conjugation").length).toBeLessThanOrEqual(2);
  });
  it("counts everything learned, without duplicates, and leaves unlearned content out", () => {
    const unlearned = learned(catalog.filter(c => c.practice.kind === "conjugation")[7], "unlearned");
    unlearned.practice!.learned = false;
    const mixed = selectMixedReviewUnits([...items, unlearned], [], [], 100, now, () => 0.5);
    const keys = mixed.units.map(u => `${u.learningItemId}:${u.ability}`);
    expect(new Set(keys).size).toBe(keys.length);
    expect(mixed.total).toBe(mixed.units.length);
    expect(mixed.units.some(u => u.learningItemId === "unlearned")).toBe(false);
    expect(Object.values(mixed.byCategory).reduce((sum, count) => sum + count, 0)).toBe(mixed.total);
    expect(mixed.byCategory.conjugation).toBeGreaterThanOrEqual(6);
  });
  it("puts unresolved mistakes ahead of other learned content in their area", () => {
    const mixed = selectMixedReviewUnits(items, [attempt("c5")], [], 3, now, () => 0.5);
    expect(mixed.units.find(u => u.learningItemId.startsWith("c"))?.learningItemId).toBe("c5");
  });
});
