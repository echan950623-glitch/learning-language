import { describe, expect, it } from "vitest";
import { hasUsableReading, requiredAbilities } from "./abilities";
import type { LearningItem } from "./types";

function item(overrides: Partial<LearningItem> = {}): LearningItem {
  return {
    id: "item-1",
    language: "ja",
    type: "vocabulary",
    promptZh: "老師",
    answer: "先生",
    reading: "せんせい",
    source: "manual",
    tags: [],
    status: "new",
    createdAt: "2026-09-15T00:00:00.000Z",
    isSeed: false,
    ...overrides,
  };
}

describe("hasUsableReading", () => {
  it("漢字項目有獨立讀音時回傳 true", () => {
    expect(hasUsableReading(item({ answer: "先生", reading: "せんせい" }))).toBe(true);
  });

  it("讀音與答案相同的純假名詞回傳 false（不重複出 reading）", () => {
    expect(hasUsableReading(item({ answer: "ありがとう", reading: "ありがとう" }))).toBe(false);
  });

  it("沒有 reading 欄位回傳 false", () => {
    expect(hasUsableReading(item({ answer: "水", reading: undefined }))).toBe(false);
  });

  it("reading 是空字串或只有空白回傳 false", () => {
    expect(hasUsableReading(item({ answer: "水", reading: "" }))).toBe(false);
    expect(hasUsableReading(item({ answer: "水", reading: "   " }))).toBe(false);
  });
});

describe("requiredAbilities", () => {
  it("有價值讀音的漢字項目需要 recall 與 reading 兩種能力", () => {
    expect(requiredAbilities(item({ answer: "先生", reading: "せんせい" }))).toEqual(["recall", "reading"]);
  });

  it("純假名詞彙（answer === reading）只需要 recall，不重複出 reading", () => {
    expect(requiredAbilities(item({ answer: "ありがとう", reading: "ありがとう" }))).toEqual(["recall"]);
  });

  it("沒有讀音欄位的項目只需要 recall", () => {
    expect(requiredAbilities(item({ answer: "hello", reading: undefined, language: "en" }))).toEqual(["recall"]);
  });
});
